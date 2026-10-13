import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Expired vehicle documents (20261112000200; owner 2026-10-13): an expired insurance warns until a person marks the
// record verified in Fleet; verified, the company rule (default: block) makes the database refuse the assignment with
// the vehicle, document, date and fix. Settings shows the rule per kind. Fictional data only.

test("a verified expired insurance blocks assignment; the rules are shown in Settings", async ({ page }) => {
  const unit = `DP-${unique()}`;
  const { truckId, driverId, loadId } = await asUser(USERS.owner.email, async (q) => {
    const truckId = (await q("insert into public.trucks (unit_number, truck_type, weight_capacity, weight_unit, capacity_verified_at) values ($1, 'tri_axle_dump', 25, 'ton', now()) returning id", [unit])).rows[0].id as string;
    await q("insert into public.vehicle_documents (truck_id, kind, reference_number, expires_on) values ($1, 'insurance', 'POL-1', (now() - interval '20 days')::date)", [truckId]);
    const driverId = (await q("insert into public.drivers (name) values ($1) returning id", [`DP Driver ${unit}`])).rows[0].id as string;
    await q("insert into public.driver_qualifications (driver_id, kind, cdl_class, expires_on, verified_at) values ($1, 'cdl', 'A', '2030-01-01', now()), ($1, 'medical_card', null, '2030-01-01', now())", [driverId]);
    const material = (await q("select id, default_unit_code as unit from public.materials where active and not is_sample order by code limit 1")).rows[0];
    const customer = (await q("select id from public.customers where active order by created_at limit 1")).rows[0].id as string;
    const today = (await q("select (now() at time zone 'America/Chicago')::date::text as d")).rows[0].d as string;
    const day = (await q("select ($1::date + 3)::text as d", [today])).rows[0].d as string;
    const order = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: customer, order_date: today, site_line1: "1 Policy Test Rd (test)",
      lines: [{ kind: "material", calc_method: "per_unit", material_id: material.id, description: "Base", unit_code: material.unit, quantity: "10", unit_rate_cents: 1000 }],
    })])).rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [order]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [order, JSON.stringify({ scheduled_start: today, scheduled_end: day })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [order]);
    const loadId = (await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: order, load_date: day, start_time: "08:00", end_time: "09:00" })])).rows[0].r.load_id as string;
    return { truckId, driverId, loadId };
  });

  await signIn(page, "owner");
  await page.goto(`/fleet/trucks/${truckId}`);
  const row = page.getByRole("listitem").filter({ hasText: "POL-1" });
  await expect(row.getByText("Not verified", { exact: true })).toBeVisible();
  await expect(page.getByText(/Blocks dispatch once verified/)).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Mark verified" }).click();
  await expectToast(page, "Document marked verified.");
  await expect(row.getByText("Verified", { exact: true })).toBeVisible();
  await expect(page.getByText(/Blocks dispatch until the renewed document is recorded/)).toBeVisible();

  // The database refuses the assignment and says why and how to fix it.
  const err = await asUser(USERS.owner.email, async (q) => {
    try {
      await q("select public.assign_load($1, $2, null, $3, '')", [loadId, truckId, driverId]);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  });
  expect(err).toContain(`Truck ${unit}: insurance expired`);
  expect(err).toContain("record the renewed document in Fleet");

  await page.goto("/settings?tab=dispatch");
  await expect(page.getByLabel("Insurance")).toHaveValue("block");
  await expect(page.getByLabel("Inspection")).toHaveValue("warn");
});
