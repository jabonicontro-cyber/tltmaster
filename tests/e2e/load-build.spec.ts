import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Smart Load Build, increment 1: a dispatcher turns what is left of an order
// into draft loads, reviews them, and approves; only then are planned loads
// added (no truck or driver assigned). Fictional data only.

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A scheduled order over three days with one material line of 93 t, and a 25 t truck of its own. */
async function fixture() {
  const id = unique();
  return asUser(USERS.office.email, async (q) => {
    await q("insert into public.trucks (unit_number, truck_type, weight_capacity, weight_unit, capacity_verified_at) values ($1, 'tri_axle_dump', 25, 'ton', now())", [`LB-${id}`]);
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({
        customer_id: cust.rows[0].id, project_name: `Load build e2e ${id}`, site_line1: `${id} Quarry Rd`, site_city: "Crown Point",
        lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "93", unit_rate_cents: 1000 }],
      }),
    ]);
    const orderId = r.rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [orderId]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [orderId, JSON.stringify({ scheduled_start: plusDays(1), scheduled_end: plusDays(3) })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [orderId]);
    return { orderId };
  });
}

const loadsOf = (orderId: string) =>
  asUser(USERS.office.email, async (q) => (await q("select load_date::text as load_date, planned_quantity::text as qty, unit_code, notes from public.order_loads where order_id = $1 and status = 'planned' order by load_number", [orderId])).rows);

test("93 t becomes three 25 t loads and one 18 t load, spread over the order's days, added only after approval", async ({ page }) => {
  const { orderId } = await fixture();
  await signIn(page, "dispatcher");
  await page.goto(`/orders/${orderId}`);
  await page.getByRole("link", { name: "Build loads" }).click();
  await expect(page.getByRole("heading", { name: "Build loads", level: 1 })).toBeVisible();
  await expect(page.getByText("93 t").first()).toBeVisible();

  await page.getByLabel("Quantity per load (t)").fill("25");
  await page.getByLabel("Loads per day").fill("2");
  await page.getByRole("button", { name: "Show draft" }).click();
  const draft = page.getByRole("table", { name: "Draft loads" });
  await expect(draft.getByRole("row")).toHaveCount(6); // header, four loads, total
  await expect(draft).toContainText("25 t");
  await expect(draft).toContainText("18 t");
  await expect(draft.getByRole("row").last()).toContainText("93 t");
  expect(await loadsOf(orderId)).toHaveLength(0); // reviewing creates nothing

  await page.getByRole("button", { name: "Approve and add 4 planned loads" }).click();
  await expectToast(page, "4 planned loads added.");
  await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));
  const loads = await loadsOf(orderId);
  expect(loads.map((l) => Number(l.qty))).toEqual([25, 25, 25, 18]);
  expect(new Set(loads.map((l) => l.load_date)).size).toBe(3); // spread over the three days, not crowded on the first
  expect(loads.every((l) => l.unit_code === "ton" && /Load build/.test(l.notes))).toBe(true);
  const assigned = await asUser(USERS.office.email, async (q) => (await q("select count(*)::int as n from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id where l.order_id = $1", [orderId])).rows[0].n);
  expect(assigned).toBe(0); // no truck or driver assigned

  // Nothing is left, so nothing more is offered.
  await page.goto(`/orders/${orderId}/load-build?payload=25&perDay=2`);
  await expect(page.getByText("Nothing left to plan")).toBeVisible();
});

test("an approval is refused when the order's loads changed after the draft was reviewed", async ({ page }) => {
  const { orderId } = await fixture();
  await signIn(page, "dispatcher");
  await page.goto(`/orders/${orderId}/load-build?payload=25&perDay=2`);
  await expect(page.getByRole("button", { name: "Approve and add 4 planned loads" })).toBeVisible();
  // Someone else plans 10 t meanwhile.
  await asUser(USERS.office.email, (q) => q("select public.save_order_load($1::jsonb)", [JSON.stringify({ order_id: orderId, load_date: plusDays(1), start_time: "06:00", end_time: "07:00", planned_quantity: "10", unit_code: "ton" })]));
  await page.getByRole("button", { name: "Approve and add 4 planned loads" }).click();
  await expect(page.getByText(/changed since you reviewed this draft/)).toBeVisible();
  expect(await loadsOf(orderId)).toHaveLength(1); // only the other person's load
});

test("people without dispatch.edit and other companies cannot build loads", async ({ page, browser }) => {
  const { orderId } = await fixture();
  await signIn(page, "mechanic");
  await page.goto(`/orders/${orderId}/load-build`);
  await expect(page).toHaveURL(/\/no-access/);

  const other = await browser.newPage();
  await signIn(other, "otherOwner");
  await other.goto(`/orders/${orderId}/load-build?payload=25&perDay=2`);
  await expect(other.getByText("Not found", { exact: true })).toBeVisible();
  await expect(other.getByText("Load build e2e")).toHaveCount(0);
  await other.close();
});
