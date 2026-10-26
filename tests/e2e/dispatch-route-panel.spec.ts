import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Dispatch and the Route Planner on one page (owner 2026-10-26): clicking an order opens its route beside the board,
// and the timeline shows each truck's loads by hour. Read only; fictional data created through the real paths. The
// order's site is typed (no saved site picked) but matches a located saved site of the customer, which the route uses.

test("an order's route opens beside the board and from the timeline", async ({ page }) => {
  const project = `Panel ${unique()}`;
  const { date, unit, orderNumber } = await asUser(USERS.owner.email, async (q) => {
    const date = (await q("select to_char((now() at time zone 'America/Chicago')::date + 11, 'YYYY-MM-DD') as d")).rows[0].d as string;
    const customer = (await q("select id from public.customers where active order by created_at limit 1")).rows[0].id as string;
    await q("insert into public.customer_sites (customer_id, label, line1, city, latitude, longitude) values ($1, $2, '2 Panel Rd', 'Testville', 40.95, -87.2)", [customer, project]);
    const material = (await q("select id, default_unit_code as unit from public.materials where active and not is_sample order by code limit 1")).rows[0];
    const r = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: customer, order_date: date, project_name: project, site_label: project, site_line1: "2 Panel Rd",
      lines: [{ kind: "material", calc_method: "per_unit", material_id: material.id, description: "Base", unit_code: material.unit, quantity: "1", unit_rate_cents: 1000 }],
    })])).rows[0].r;
    const order = r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [order]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [order, JSON.stringify({ scheduled_start: date, scheduled_end: date })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [order]);
    const load = (await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: order, load_date: date, start_time: "04:00", end_time: "04:30", planned_quantity: "1", unit_code: material.unit })])).rows[0].r.load_id as string;
    const trucks = (await q("select id, unit_number from public.trucks where active and service_status = 'in_service' and truck_type <> 'tractor' order by unit_number")).rows;
    const drivers = (await q("select id from public.drivers where active order by name")).rows;
    for (const t of trucks) for (const d of drivers) {
      await q("savepoint a");
      try {
        await q("select public.assign_load($1, $2, null, $3, '')", [load, t.id, d.id]);
        await q("release savepoint a");
        return { date, unit: t.unit_number as string, orderNumber: r.order_number as string };
      } catch {
        await q("rollback to savepoint a");
      }
    }
    throw new Error("No truck and driver could take the test load.");
  });

  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${date}`);
  await page.getByRole("button", { name: `Route for ${orderNumber}` }).click();
  const panel = page.getByRole("complementary", { name: "Order route" });
  await expect(panel.getByRole("heading", { name: `Order ${orderNumber}` })).toBeVisible();
  await expect(panel.getByText("Suggested route for each load")).toBeVisible();
  // The truck's first load of the day sets off from the yard.
  await expect(panel.getByRole("list", { name: "Loads" }).getByRole("listitem", { name: "Load 1" })).toContainText("Start of the day, from the yard");
  const truck = panel.getByRole("region", { name: "Trucks on this order" });
  await expect(truck).toContainText(`Truck ${unit}`);
  // The typed site matched the customer's located saved site: the stop has a location.
  await expect(truck.getByRole("listitem").filter({ hasText: project })).not.toContainText("Location missing");
  await panel.getByRole("button", { name: "Close the route" }).click();
  await expect(panel).toHaveCount(0);

  await page.getByRole("navigation", { name: "Dispatch views" }).getByRole("link", { name: "Timeline" }).click();
  await expect(page).toHaveURL(/view=timeline/);
  const row = page.getByRole("table", { name: "Trucks by hour" }).getByRole("row").filter({ hasText: `Truck ${unit}` });
  await row.getByRole("button", { name: new RegExp(`^${orderNumber} load`) }).click();
  await expect(page.getByRole("complementary", { name: "Order route" }).getByRole("heading", { name: `Order ${orderNumber}` })).toBeVisible();
});
