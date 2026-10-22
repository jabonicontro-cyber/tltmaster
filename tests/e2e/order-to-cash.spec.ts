import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";
import { asUser, realMaterial } from "./db";
import { USERS } from "./users";

// Order-to-Cash Control Center (B42 increment 1): an order is placed on its stage with why, the next step and the
// team; a confirmed order without a date waits in Needs scheduling; people without billing access cannot open it.
// Fictional data only.

test("an unscheduled order shows in Needs scheduling with the next step and team; stages filter the list", async ({ page }) => {
  const project = `O2C ${unique()}`;
  await asUser(USERS.owner.email, async (q) => {
    const material = await realMaterial(q);
    const customer = (await q("select id from public.customers where active order by created_at limit 1")).rows[0].id as string;
    const today = (await q("select (now() at time zone 'America/Chicago')::date::text as d")).rows[0].d as string;
    const order = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: customer, order_date: today, project_name: project, site_line1: "1 Cash Rd (test)",
      lines: [{ kind: "material", calc_method: "per_unit", material_id: material.id, description: "Base", unit_code: material.unit, quantity: "10", unit_rate_cents: 1000 }],
    })])).rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [order]);
  });

  await signIn(page, "owner");
  await page.goto(`/order-to-cash?q=${encodeURIComponent(project)}`);
  await expect(page.getByRole("heading", { name: "Order to cash", level: 1 })).toBeVisible();
  await expect(page.getByText("Coming soon")).toBeVisible(); // invoices and payments are labelled, never implied
  const row = page.getByRole("row").filter({ hasText: project });
  await expect(row).toContainText("Needs scheduling");
  await expect(row.getByRole("link", { name: "Schedule the order" })).toHaveAttribute("href", "/dispatch#needs-scheduling");
  await expect(row).toContainText("Dispatch");

  // Stage cards filter the list.
  await page.getByRole("list", { name: "Stages" }).getByRole("link", { name: /Ready to bill/ }).click();
  await page.waitForURL(/stage=ready/);
  await expect(page.getByRole("row").filter({ hasText: project })).toHaveCount(0);
});

test("people without billing access cannot open Order to cash", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/order-to-cash");
  await page.waitForURL(/\/no-access\?missing=billing\.view/);
});
