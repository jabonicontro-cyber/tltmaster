import { expect, test, type Locator } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Mechanic and dispatcher decisions of 2026-11-09 (master plan MD1): a part on order for a job not started leaves the
// truck dispatchable with a note on the board and in the Assign window; a wrong reading is marked wrong on the truck's
// page; the office checks a certificate the shop recorded; a truck parked by hand is offered back once its shop work
// is done (20261120015000-015300).

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const formatted = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));

async function choose(select: Locator, prefix: string) {
  const value = await select.locator("option", { hasText: prefix }).first().getAttribute("value");
  await select.selectOption(value!);
}

test("a part on order for a job not started: the truck stays dispatchable, with the note on the board and in Assign", async ({ page }) => {
  const id = unique();
  const unit = `PO-${id}`;
  const date = plusDays(30 + (Date.now() % 150));
  const expected = plusDays(4);
  const part = `Seat cushion (e2e ${id})`;
  const driver = `Parker Driver ${id}`;
  await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title: `Seat torn (e2e ${id})` })])).rows[0].r.id as string;
    await q("select public.part_wait_add($1, $2::jsonb)", [wo, JSON.stringify({ description: part, expected_on: expected, set_waiting: true })]);
    const d = (await q("insert into public.drivers (name) values ($1) returning id", [driver])).rows[0].id as string;
    for (const kind of ["cdl", "medical_card"]) {
      await q("insert into public.driver_qualifications (driver_id, kind, cdl_class, expires_on, verified_at) values ($1, $2, $3, $4, now())", [d, kind, kind === "cdl" ? "A" : null, plusDays(600)]);
    }
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
    const r = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: cust.rows[0].id, project_name: `Part on order e2e ${id}`, site_line1: "7 Parts Lane (test)", site_city: "Crown Point",
      lines: [{ kind: "other", calc_method: "per_unit", description: "Hauling (e2e)", unit_code: "load", quantity: "1", unit_rate_cents: 10000 }],
    })])).rows[0].r as { order_id: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [r.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [r.order_id, JSON.stringify({ scheduled_start: date, window_start: "07:00", window_end: "15:00" })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [r.order_id]);
    await q("select public.save_order_load($1::jsonb)", [JSON.stringify({ order_id: r.order_id, load_date: date, start_time: "08:00", end_time: "10:00" })]);
  });

  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${date}`);
  const note = `Part on order: ${part}, expected ${formatted(expected)}.`;
  const row = page.getByRole("list", { name: /^Trucks / }).getByRole("listitem").filter({ has: page.getByRole("link", { name: unit, exact: true }) });
  await expect(row.getByTestId("part-on-order-note")).toContainText(note);
  await expect(row.getByText("In the shop")).toHaveCount(0);

  const orderCard = page.locator("section").filter({ hasText: `Part on order e2e ${id}` });
  await orderCard.getByRole("listitem", { name: "Load 1", exact: true }).getByRole("button", { name: "Assign", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await choose(dialog.getByLabel("Truck"), unit);
  await choose(dialog.getByLabel("Driver"), driver);
  await expect(dialog.getByText("This combination can be assigned.")).toBeVisible();
  await expect(dialog.getByText(`Note: ${note}`)).toBeVisible();
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  await expectToast(page, "Load assigned.");
});

test("a wrong reading is marked wrong on the truck's page; the readings not used are listed", async ({ page }) => {
  const id = unique();
  const unit = `RW-${id}`;
  const truck = await asUser(USERS.owner.email, async (q) => {
    const t = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
    await q("select public.record_truck_reading($1, 100000, null, '')", [t]);
    // One digit typed wrong (101,900 for 100,190): it is used, and the correct reading after it is not. The fuel slip is
    // dated yesterday: today in UTC can still be tomorrow in the company's time zone.
    await q("select public.record_truck_reading($1, 101900, null, 'typo')", [t]);
    await q("select public.fuel_record_purchase($1::jsonb)", [JSON.stringify({ truck_id: t, purchased_on: plusDays(-1), jurisdiction: "IA", gallons: "50", total_cents: 20000, odometer: 100250 })]);
    return t;
  });

  await signIn(page, "mechanic");
  await page.goto(`/fleet/trucks/${truck}`);
  const readings = page.getByTestId("truck-readings");
  await expect(readings).toContainText("Current: 101,900 mi");
  await expect(readings.getByTestId("readings-not-used")).toContainText("Odometer 100,250 mi from a fuel entry was not used: lower than the current reading at the time, 101,900 mi.");
  await readings.getByRole("button", { name: "Mark the reading 101,900 mi as wrong" }).click();
  await readings.getByLabel("Why is it wrong?").fill("Typo on the fuel slip");
  await readings.getByRole("button", { name: "Set it aside" }).click();
  await expectToast(page, "Reading set aside. The current reading is now 100,000 mi.");
  await expect(readings).toContainText("Current: 100,000 mi");
  await expect(readings.getByText("Marked wrong")).toBeVisible();
  await expect(readings).toContainText("Typo on the fuel slip");
});

test("the office checks an inspection certificate the shop recorded", async ({ page }) => {
  const id = unique();
  const unit = `IC-${id}`;
  const truck = await asUser(USERS.owner.email, async (q) => {
    const t = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: t, title: `Annual DOT inspection (e2e ${id})`, category: "inspection" })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'in_progress', '')", [wo]);
    await q("select public.maintenance_set_status($1, 'completed', '')", [wo]);
    await q("select public.maintenance_record_inspection($1, $2::jsonb)", [wo, JSON.stringify({ inspected_on: plusDays(-1), expires_on: plusDays(360), inspector: "Pat Inspector (e2e)" })]);
    return t;
  });

  await signIn(page, "office");
  // The office's to-do: an alert addressed to the people who can check it (20261120015700).
  const todo = `Check the inspection certificate of truck ${unit}`;
  await page.goto("/communications/alerts");
  await expect(page.getByRole("link", { name: todo, exact: true })).toBeVisible();
  await page.goto(`/fleet/trucks/${truck}`);
  await expect(page.getByText("Not checked yet")).toBeVisible();
  await page.goto("/fleet");
  const card = page.getByTestId("certificates-to-check");
  const item = card.getByRole("listitem").filter({ hasText: unit });
  await expect(item).toContainText("Not checked yet");
  await expect(item).toContainText("by Pat Inspector (e2e)");
  await item.getByRole("button", { name: `Mark the inspection certificate of truck ${unit} checked` }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Mark the inspection certificate checked?")).toBeVisible();
  await confirm.getByRole("button", { name: "Mark checked" }).click();
  await expectToast(page, "Certificate checked.");
  await expect(page.getByTestId("certificates-to-check").getByRole("listitem").filter({ hasText: unit })).toHaveCount(0);
  // Checked: the to-do is resolved.
  await page.goto("/communications/alerts");
  await expect(page.getByRole("link", { name: todo, exact: true })).toHaveCount(0);
});

test("a truck parked by hand is offered back once its shop work is done; only the shop or office can put it back", async ({ page, browser }) => {
  const id = unique();
  const unit = `PK-${id}`;
  await asUser(USERS.owner.email, async (q) => {
    const t = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
    await q("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Waiting on new tires (e2e)', null)", [t]);
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: t, title: `Steer tires (e2e ${id})`, category: "tires" })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'in_progress', '')", [wo]);
    await q("select public.maintenance_set_status($1, 'completed', '')", [wo]);
  });
  const question = `All shop work on truck ${unit} is done. Put it back in service?`;

  // Dispatch sees the question, and who can act on it.
  await signIn(page, "dispatcher");
  await page.goto("/dispatch");
  const forDispatch = page.getByTestId("back-from-shop").locator("div").filter({ hasText: question }).first();
  await expect(forDispatch).toContainText("Ask the office or the shop to put it back in service.");
  await expect(forDispatch.getByRole("button")).toHaveCount(0);

  // The shop puts it back in one tap.
  const shop = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
  await signIn(shop, "mechanic");
  await shop.goto("/maintenance");
  await expect(shop.getByText(question)).toBeVisible();
  await shop.getByRole("button", { name: `Put truck ${unit} back in service` }).click();
  await expectToast(shop, `Truck ${unit} is back in service and can be assigned.`);
  await expect(shop.getByText(question)).toHaveCount(0);
  await shop.context().close();
});
