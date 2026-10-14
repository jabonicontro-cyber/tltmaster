import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

// N14: a confirmed order without a delivery date is not lost — it waits in
// Dispatch's "Needs scheduling" queue and in the Command Center until someone
// schedules it; billing shows an invoice draft built only from verified
// deliveries; Reports shows measured figures, money only with billing access.
test.describe.configure({ mode: "serial" });

async function confirmedOrderWithoutDate(project: string) {
  return asUser(USERS.office.email, async (q) => {
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mat = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d;
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      // Requested for today: it is urgent, so it sorts to the top of the queue.
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: today, requested_date: today, project_name: project,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mat.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
    })]);
    const o = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    return o;
  });
}

test("a confirmed order without a date waits in Needs scheduling, then lands on the board for the chosen day", async ({ page }) => {
  const project = `Needs date ${unique()}`;
  const o = await confirmedOrderWithoutDate(project);

  await signIn(page, "dispatcher");
  await page.goto("/command-center?kind=order_unscheduled#attention");
  const item = page.getByRole("listitem").filter({ hasText: `${o.order_number} (Prairie View Landscaping) needs a delivery date` });
  await expect(item).toBeVisible();
  await expect(item).toContainText("The customer asked for delivery by tomorrow or today.");
  await item.getByRole("link", { name: "Schedule it" }).click();
  await expect(page).toHaveURL(/\/dispatch(\?[^#]*)?#needs-scheduling$/);

  const queue = page.getByRole("region", { name: "Needs scheduling" });
  const row = queue.getByRole("listitem").filter({ hasText: o.order_number });
  await expect(row).toContainText(project);
  // The customer's requested date is offered; the dispatcher picks another day.
  await expect(row.getByLabel(`Delivery date for ${o.order_number}`, { exact: true })).not.toHaveValue("");
  const day = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  await row.getByLabel(`Delivery date for ${o.order_number}`, { exact: true }).fill(day);
  await row.getByRole("button", { name: "Schedule" }).click();
  await expect(page).toHaveURL(new RegExp(`/dispatch\\?date=${day}`));
  await expect(page.getByText(o.order_number).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Needs scheduling" }).getByText(o.order_number)).toHaveCount(0);

  // The order itself is Scheduled with that date.
  await page.goto("/orders?q=" + encodeURIComponent(o.order_number));
  await expect(page.getByRole("row").filter({ hasText: o.order_number })).toContainText("Scheduled");
});

test("billing shows an invoice draft from verified deliveries only, clearly not an invoice", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/billing?view=all");
  // Any order with tickets will do; the billing e2e creates such orders.
  const link = page.getByRole("link", { name: /^O-\d{4}-\d{4}$/ }).first();
  await link.click();
  await expect(page).toHaveURL(/\/billing\/orders\//);
  const draft = page.getByRole("table", { name: "Invoice draft" });
  await expect(draft).toBeVisible();
  await expect(page.getByText(/This is not an invoice: nothing has been issued, sent or recorded in accounting/)).toBeVisible();
  await expect(page.getByText("Draft total")).toBeVisible();
});

test("reports show measured figures; money only with billing access", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/reports?days=90");
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "Deliveries and rework" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Verified delivered value" })).toBeVisible();
  await expect(page.getByText("Profitability is not calculated yet")).toBeVisible();
  await expect(page.getByRole("navigation").first().getByRole("link", { name: "Reports", exact: true })).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "dispatcher");
  await page.goto("/reports?days=90");
  await expect(page.getByRole("region", { name: "Truck utilization" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Verified delivered value" })).toHaveCount(0);
  await expect(page.getByText(/Verified delivered value/)).toHaveCount(0);
});
