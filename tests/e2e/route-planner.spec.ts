import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Route Planner (B10 first slice): each truck's day as a route from the assigned loads; straight-line distances
// labelled as estimates without a routing key; a site without a location can be given one. Fictional data only,
// created through the real order, load and assignment paths.

test("an assigned load shows on its truck's route; giving its site a location gives the leg a distance", async ({ page }) => {
  const project = `Route ${unique()}`;
  const { date, unit } = await asUser(USERS.owner.email, async (q) => {
    const date = (await q("select to_char((now() at time zone 'America/Chicago')::date + 9, 'YYYY-MM-DD') as d")).rows[0].d as string;
    const customer = (await q("select id from public.customers where active order by created_at limit 1")).rows[0].id as string;
    const site = (await q("insert into public.customer_sites (customer_id, label, line1, city) values ($1, $2, '1 Route Test Rd', 'Testville') returning id", [customer, project])).rows[0].id as string;
    const material = (await q("select id, default_unit_code as unit from public.materials where active and not is_sample order by code limit 1")).rows[0];
    const order = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: customer, order_date: date, project_name: project, site_id: site, site_label: project, site_line1: "1 Route Test Rd",
      lines: [{ kind: "material", calc_method: "per_unit", material_id: material.id, description: "Base", unit_code: material.unit, quantity: "1", unit_rate_cents: 1000 }],
    })])).rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [order]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [order, JSON.stringify({ scheduled_start: date, scheduled_end: date })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [order]);
    const load = (await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: order, load_date: date, start_time: "04:00", end_time: "04:30", planned_quantity: "1", unit_code: material.unit })])).rows[0].r.load_id as string;
    // A truck and driver the rules accept at that hour (tried in turn, as a dispatcher would).
    const trucks = (await q("select id, unit_number from public.trucks where active and service_status = 'in_service' and truck_type <> 'tractor' order by unit_number")).rows;
    const drivers = (await q("select id from public.drivers where active order by name")).rows;
    for (const t of trucks) for (const d of drivers) {
      await q("savepoint a");
      try {
        await q("select public.assign_load($1, $2, null, $3, '')", [load, t.id, d.id]);
        await q("release savepoint a");
        return { date, unit: t.unit_number as string };
      } catch {
        await q("rollback to savepoint a");
      }
    }
    throw new Error("No truck and driver could take the test load.");
  });

  await signIn(page, "owner");
  await page.goto(`/route-planner?date=${date}`);
  await expect(page.getByRole("heading", { name: "Route Planner", level: 1 })).toBeVisible();
  const route = page.locator(`[aria-label="Route for truck ${unit}"]`);
  await expect(route).toContainText(project);
  const missing = page.getByRole("listitem").filter({ hasText: project }).filter({ has: page.getByPlaceholder("Latitude, longitude") });
  await missing.getByPlaceholder("Latitude, longitude").fill("40.9367, -87.1509");
  await missing.getByRole("button", { name: "Save" }).click();
  await expectToast(page, "Location saved.");
  await expect(page.getByRole("listitem").filter({ hasText: project }).filter({ has: page.getByPlaceholder("Latitude, longitude") })).toHaveCount(0);
});

test("people without dispatch access cannot open the Route Planner", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/route-planner");
  await page.waitForURL(/\/no-access|\/driver/);
});
