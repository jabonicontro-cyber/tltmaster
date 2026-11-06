import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { driverUserId } from "./driver-fixture";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Truck-day jobs (UX11, 20261120008600): the order page sets "Trucks for the day"; dispatch adds trucks for the day and
// assigns them; the driver's My Day shows the day card with "I'm released"; dispatch releases a truck; billing shows the
// truck-hours card (off until the company chooses which hours count).

test("an order runs as trucks for the day: plan, assign, driver card, release, billing hours", async ({ browser }) => {
  test.slow();
  const id = unique();
  const driverUser = await driverUserId();
  const setup = await asUser(USERS.owner.email, async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    await q("update public.drivers set user_id = null, name = 'Drew Driver (earlier e2e run)', active = false where user_id = $1", [driverUser]);
    const verified = new Date().toISOString();
    const driver = async (row: Record<string, unknown>) => {
      const d = await ins("drivers", row);
      await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: "2030-01-01", verified_at: verified });
      await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: "2030-01-01", verified_at: verified });
      return d;
    };
    const me = await driver({ user_id: driverUser });
    const other = await driver({ name: `TD Other ${id}` });
    const t1 = await ins("trucks", { unit_number: `TD1-${id}`, truck_type: "tri_axle_dump" });
    const t2 = await ins("trucks", { unit_number: `TD2-${id}`, truck_type: "tri_axle_dump" });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping'");
    const mat = await q("select id from public.materials where code = 'GRV-53'");
    const o = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: today, project_name: `Truck day ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mat.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "200", unit_rate_cents: 1000 }],
    })])).rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: today, scheduled_end: null })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    return { orderId: o.order_id, orderNumber: o.order_number, today, me, other, t1, t2 };
  });

  // The owner sets how the order runs on its page.
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, "owner");
  await owner.goto(`/orders/${setup.orderId}`);
  await owner.getByLabel("How this order runs").selectOption("truck_day");
  await owner.getByLabel("How this order is billed").selectOption("hours");
  await owner.getByRole("button", { name: "Save how it runs" }).click();
  await expectToast(owner, "This order now runs as trucks for the day.");

  // Dispatch adds two trucks for the day (one tap, two slots).
  const dispatch = await (await browser.newContext()).newPage();
  await signIn(dispatch, "dispatcher");
  await dispatch.goto(`/dispatch?date=${setup.today}`);
  // The order's card: the nearest container of its number link that also holds its "Add trucks" button.
  const card = dispatch.getByRole("link", { name: setup.orderNumber, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add trucks']][1]");
  await expect(card.getByText("Trucks for the day")).toBeVisible();
  await card.getByRole("button", { name: "Add trucks" }).click();
  const dialog = dispatch.getByRole("dialog");
  await dialog.getByLabel("Trucks").fill("2");
  await dialog.getByLabel("From").fill("00:00");
  await dialog.getByLabel("Until (planned)").fill("23:59");
  await dialog.getByRole("button", { name: "Add trucks" }).click();
  await expectToast(dispatch, "2 trucks added for the day. Assign a truck and driver to each.");

  // Assign both (through the same function as the board).
  await asUser(USERS.dispatcher.email, async (q) => {
    const slots = (await q("select id from public.order_loads where order_id = $1 order by load_number", [setup.orderId])).rows.map((r) => r.id as string);
    await q("select public.assign_load($1, $2, null, $3, '', null)", [slots[0], setup.t1, setup.me]);
    await q("select public.assign_load($1, $2, null, $3, '', null)", [slots[1], setup.t2, setup.other]);
  });

  // The driver sees one day card with the trip count and "I'm released".
  const driver = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await signIn(driver, "driver");
  await driver.goto("/driver");
  const dayCard = driver.getByRole("listitem").filter({ hasText: setup.orderNumber });
  await expect(dayCard.getByText("Truck for the day:")).toBeVisible();
  await expect(dayCard.getByText("0 trips so far.")).toBeVisible();
  await expect(dayCard.getByRole("button", { name: "I'm released" })).toBeVisible();

  // Dispatch releases the other truck from the board.
  await dispatch.reload();
  const fullCard = dispatch.getByRole("link", { name: setup.orderNumber, exact: true }).locator("xpath=ancestor::*[.//li[@aria-label='Load 2']][1]");
  const slot2 = fullCard.getByRole("listitem", { name: "Load 2" });
  await slot2.getByRole("button", { name: "Release" }).click();
  await dispatch.getByRole("dialog").getByRole("button", { name: "Release" }).click();
  await expectToast(dispatch, "Truck released.");
  await expect(slot2.getByText(/Released .* by dispatch/)).toBeVisible();

  // Billing shows the truck-hours card; hours are off until the company chooses which hours count.
  const office = await (await browser.newContext()).newPage();
  await signIn(office, "office");
  await office.goto(`/billing/orders/${setup.orderId}`);
  const hours = office.getByRole("table", { name: "Truck-hours" });
  await expect(hours.getByRole("row")).toHaveCount(3);
  await expect(office.getByText("Truck-hours are off.")).toBeVisible();
});
