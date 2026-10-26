import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

// Faster dispatching (master plan B85): copy the previous crew, assign several loads at once, drag and drop, keyboard
// shortcuts. Every assignment still goes through assign_load; nothing is assigned without the dispatcher's click.

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Fixture {
  day1: string;
  day2: string;
  orderNumber: string;
  truck1: string;
  truck2: string;
  driverA: string;
  driverB: string;
}

/**
 * A fictional order scheduled over two days: on day 1 one load worked by truck 1 and driver A (driver A's usual truck);
 * on day 2 the given loads, all still open.
 */
async function fixture(day2Loads: Array<[string, string]>): Promise<Fixture> {
  const id = unique();
  const day1 = plusDays(300 + (Date.now() % 300));
  const day2 = plusDays(301 + (Date.now() % 300));
  const far = plusDays(1200);
  const truck1 = `SPD1-${id}`;
  const truck2 = `SPD2-${id}`;
  // Fleet and the order are set up by the office; loads and the day-1 assignment by the dispatcher (their own permissions).
  const setup = await asUser(USERS.office.email, async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
      return r.rows[0].id as string;
    };
    const verified = new Date().toISOString();
    const t1 = await ins("trucks", { unit_number: truck1, truck_type: "tri_axle_dump" });
    await ins("trucks", { unit_number: truck2, truck_type: "tri_axle_dump" });
    const names = { driverA: `Ainsley Speed ${id}`, driverB: `Bowen Speed ${id}` };
    const driverIds: Record<string, string> = {};
    for (const [key, name] of Object.entries(names)) {
      const d = await ins("drivers", { name });
      driverIds[key] = d;
      await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
      await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: far, verified_at: verified });
    }
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({ customer_id: cust.rows[0].id, project_name: `Speed e2e ${id}`, site_line1: "7 Sample Road", site_city: "Crown Point", lines: [{ kind: "other", calc_method: "per_unit", description: "Hauling (e2e)", unit_code: "load", quantity: "6", unit_rate_cents: 10000 }] }),
    ]);
    const orderId = r.rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [orderId]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [orderId, JSON.stringify({ scheduled_start: day1, scheduled_end: day2, window_start: "06:00", window_end: "18:00" })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [orderId]);
    return { orderId, orderNumber: r.rows[0].r.order_number as string, t1, driverA: driverIds.driverA, names };
  });
  // Driver A's usual truck is truck 1, set by the owner the way the Fleet page does it (fleet.assign).
  await asUser(USERS.owner.email, (q) => q("select public.assign_truck_driver($1, $2)", [setup.t1, setup.driverA]));
  return asUser(USERS.dispatcher.email, async (q) => {
    const { orderId, t1, names } = setup;
    const load = async (date: string, start: string, end: string) =>
      (await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: orderId, load_date: date, start_time: start, end_time: end, notes: "" })])).rows[0].r.load_id as string;
    const first = await load(day1, "07:00", "09:00");
    await q("select public.assign_load($1, $2, null, $3, '', null)", [first, t1, setup.driverA]);
    for (const [s, e] of day2Loads) await load(day2, s, e);
    return { day1, day2, orderNumber: setup.orderNumber, truck1, truck2, ...names };
  });
}

test("copy the previous crew: yesterday's truck and driver are proposed for today's open loads and assigned on approval", async ({ page }) => {
  const f = await fixture([["07:00", "09:00"], ["10:00", "12:00"]]);
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${f.day2}`);
  await page.getByRole("button", { name: /Copy previous crew/ }).click();
  const dialog = page.getByRole("dialog", { name: "Copy the previous crew" });
  const rows = dialog.getByRole("list", { name: "Proposed crews" }).getByRole("listitem").filter({ hasText: f.orderNumber });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(`Truck ${f.truck1}`);
  await expect(rows.first()).toContainText(f.driverA);
  await dialog.getByRole("button", { name: /^Assign \d+ loads?$/ }).click();
  const results = dialog.getByRole("list", { name: "Results" });
  await expect(results.getByText("Assigned").first()).toBeVisible();
  await expect(results).not.toContainText("Could not");
  await dialog.getByRole("button", { name: "Done" }).click();
  const card = page.locator("section").filter({ has: page.getByRole("link", { name: f.orderNumber, exact: true }) });
  await expect(card.getByText("Needs a truck and driver")).toHaveCount(0);
});

test("assign several loads at once: one crew for the selected loads, overlapping ones left open with the reason", async ({ page }) => {
  const f = await fixture([["07:00", "09:00"], ["08:00", "10:00"], ["11:00", "13:00"]]);
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${f.day2}`);
  const card = page.locator("section").filter({ has: page.getByRole("link", { name: f.orderNumber, exact: true }) });
  // Load numbers run across the order: day 1 had load 1, so day 2's loads are 2, 3 and 4.
  for (const n of [2, 3, 4]) await card.getByRole("checkbox", { name: `Select load ${n} of ${f.orderNumber}` }).check();
  const bar = page.getByRole("region", { name: "Selected loads" });
  await expect(bar).toContainText("3 loads selected");
  await bar.getByRole("button", { name: "Assign selected" }).click();
  const dialog = page.getByRole("dialog", { name: "Assign 3 loads" });
  const value = async (label: string, text: string) => (await dialog.getByLabel(label).locator("option", { hasText: text }).first().getAttribute("value"))!;
  await dialog.getByLabel("Truck").selectOption(await value("Truck", f.truck2));
  await dialog.getByLabel("Driver").selectOption(await value("Driver", f.driverB));
  // Load 3 overlaps load 2: the board's own check says so before anything is saved.
  await expect(dialog.getByRole("list", { name: "Selected loads" })).toContainText("already booked at that time");
  await dialog.getByRole("button", { name: "Assign 2 loads" }).click();
  const results = dialog.getByRole("list", { name: "Results" });
  await expect(results.getByText("Assigned")).toHaveCount(2);
  await expect(results).toContainText("Left open");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(card.getByText("Needs a truck and driver")).toHaveCount(1);
});

test("drag a driver onto a load: the assign dialog opens with the driver and their usual truck filled in", async ({ page }) => {
  const f = await fixture([["07:00", "09:00"]]);
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${f.day2}`);
  const card = page.locator("section").filter({ has: page.getByRole("link", { name: f.orderNumber, exact: true }) });
  const driver = page.getByRole("list", { name: "Drivers today" }).getByRole("listitem").filter({ hasText: f.driverA });
  // Drag events on the exact rows with one shared DataTransfer (a mouse drag across this long test board scrolls the
  // page mid-drag and can pick up a different row).
  const target = card.getByRole("listitem", { name: "Load 2", exact: true });
  const data = await page.evaluateHandle(() => new DataTransfer());
  await driver.dispatchEvent("dragstart", { dataTransfer: data });
  await target.dispatchEvent("dragover", { dataTransfer: data });
  await target.dispatchEvent("drop", { dataTransfer: data });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Driver").locator("option:checked")).toHaveText(new RegExp(f.driverA));
  await expect(dialog.getByLabel("Truck").locator("option:checked")).toHaveText(new RegExp(f.truck1));
  await expect(dialog.getByText("This combination can be assigned.")).toBeVisible();
});

test("keyboard: arrows change the day and ? lists the shortcuts", async ({ page }) => {
  const f = await fixture([["07:00", "09:00"]]);
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${f.day2}`);
  await page.locator("body").click({ position: { x: 5, y: 300 } });
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(new RegExp(`date=${f.day1}`));
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
});
