import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Worst-case data on a phone: a customer with a very long name must never make a page scroll sideways (a filter
// dropdown sized itself to the longest customer name and widened Billing and the Command Center by 525 px).
// Fictional data only.

test("a very long customer name never widens pages on a phone", async ({ page }) => {
  const tag = unique();
  await asUser(USERS.owner.email, async (q) => {
    const customer = (await q("insert into public.customers (name) values ($1) returning id", [
      `Northwestern Regional Aggregate and Infrastructure Development Cooperative of Greater Prairie Counties ${tag}`,
    ])).rows[0].id;
    const material = (await q("select id, default_unit_code as unit from public.materials where active and not is_sample order by code limit 1")).rows[0];
    const today = (await q("select (now() at time zone 'America/Chicago')::date::text as d")).rows[0].d as string;
    const order = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: customer, order_date: today, project_name: "Extraordinarily long project name for the interchange reconstruction, phase four",
      site_label: "Interchange reconstruction staging yard number seventeen", site_line1: "123456 Supercalifragilistic Industrial Parkway Northeast", site_city: "Lake Of The Woods",
      lines: [{ kind: "material", calc_method: "per_unit", material_id: material.id, description: "Washed crushed limestone base", unit_code: material.unit, quantity: "44", unit_rate_cents: 1500, taxable: true }],
    })])).rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [order]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [order, JSON.stringify({ scheduled_start: today, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [order]);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "owner");
  for (const path of ["/billing", "/command-center", "/orders", "/dispatch"]) {
    await page.goto(path);
    await expect(page.getByRole("main")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} scrolls sideways`).toBe(0);
  }
});
