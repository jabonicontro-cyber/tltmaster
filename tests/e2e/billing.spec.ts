import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;

/** A scheduled order (gravel 44 t + hauling 2 loads) with yesterday's load (22 t planned) assigned; no ticket yet. */
async function fixture() {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
      return r.rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const truckId = await ins("trucks", { unit_number: `BIL-${id}`, truck_type: "tri_axle_dump" });
    const driverId = await ins("drivers", { name: `Billie Driver ${id}` });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driverId, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
    await ins("driver_qualifications", { driver_id: driverId, kind: "medical_card", expires_on: plusDays(600), verified_at: verified });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({
        site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id,
        order_date: yesterday,
        project_name: `Billing e2e ${id}`,
        lines: [
          { kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 },
          { kind: "other", calc_method: "per_unit", description: "Hauling (e2e)", unit_code: "load", quantity: "2", unit_rate_cents: 10000 },
        ],
      }),
    ]);
    const res = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [res.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [res.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [res.order_id]);
    const load = await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: res.order_id, load_date: yesterday, start_time: "07:00", end_time: "09:00", planned_quantity: "22", unit_code: "ton" })]);
    const loadId = (load.rows[0].r as { load_id: string }).load_id;
    await q("select public.assign_load($1, $2, null, $3, '', null)", [loadId, truckId, driverId]);
    const line = (await q("select id from public.order_lines where order_id = $1 and line_no = 1", [res.order_id])).rows[0].id as string;
    return { orderId: res.order_id, orderNumber: res.order_number, loadId, line, yesterday, paper: `SC-${id}` };
  });
}

test("office follows an order from a missing ticket to a billing handoff and back", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "office");

  // 1. The delivered load has no ticket.
  await page.goto(`/billing?view=missing&q=${f.orderNumber}`);
  const missing = page.getByRole("row").filter({ hasText: f.orderNumber });
  await expect(missing.getByText("Load ended; no ticket entered.")).toBeVisible();
  await expect(missing.getByRole("link", { name: "Enter ticket" })).toHaveAttribute("href", `/tickets/new?load=${f.loadId}`);
  await page.goto(`/billing?q=${f.orderNumber}`);
  await expect(page.getByRole("row").filter({ hasText: f.orderNumber }).getByText("Missing documentation")).toBeVisible();

  // 2. A ticket is entered (21.47 t against 22 t planned) and waits for review.
  const ticket = await office(async (q) => {
    const r = await q("select public.submit_delivery_ticket($1::jsonb) as r", [
      JSON.stringify({ load_id: f.loadId, order_line_id: f.line, delivered_date: f.yesterday, delivered_time: "08:30", quantity: "21.47", unit_code: "ton", external_reference: f.paper }),
    ]);
    return r.rows[0].r as { ticket_id: string; ticket_number: string };
  });
  await page.goto(`/billing?view=review&q=${f.orderNumber}`);
  await expect(page.getByRole("link", { name: ticket.ticket_number })).toBeVisible();

  // 3. Accepted and the order completed: the differences block billing.
  await office(async (q) => {
    await q("select public.review_delivery_ticket($1, 'accept', '')", [ticket.ticket_id]);
    await q("select public.set_order_status($1, 'in_progress', '')", [f.orderId]);
    await q("select public.set_order_status($1, 'completed', '')", [f.orderId]);
  });
  await page.goto(`/billing?view=exceptions&q=${f.orderNumber}`);
  const group = page.getByRole("list", { name: "Orders with exceptions" }).getByRole("listitem").filter({ hasText: f.orderNumber });
  await expect(group.getByRole("row").filter({ hasText: "Load: delivered differs from planned — load 1" })).toContainText("-0.53");
  await expect(group.getByRole("row").filter({ hasText: "Order line: delivered differs from ordered — line 1" })).toContainText("-22.53");
  await expect(group.getByText("Order line: no ticket — line 2")).toBeVisible();
  await group.getByRole("button", { name: "Acknowledge" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("dialog").getByText("Enter the reason")).toBeVisible();
  await page.getByRole("dialog").getByLabel("Reason").fill("Customer confirmed partial delivery (e2e)");
  await page.getByRole("dialog").getByRole("button", { name: "Acknowledge" }).click();
  await expectToast(page, "Exceptions acknowledged.");
  await expect(group.getByText("Customer confirmed partial delivery (e2e)")).toBeVisible();

  // 4. Ready: hand it off in a batch.
  await page.goto(`/billing?view=ready&q=${f.orderNumber}`);
  await page.getByRole("checkbox", { name: `Select ${f.orderNumber}` }).check();
  await page.getByRole("button", { name: "Hand off selected" }).click();
  await page.getByRole("dialog").getByLabel("Reference (optional)").fill("QB entry e2e");
  await page.getByRole("dialog").getByRole("button", { name: "Create batch" }).click();
  await expectToast(page, /Batch B-\d{4}-\d{4} created with 1 order\./);
  await expect(page).toHaveURL(/view=handed_off/);
  const batch = page.getByRole("listitem").filter({ hasText: f.orderNumber }).filter({ hasText: "QB entry e2e" });
  await expect(batch).toBeVisible();

  // 5. The batch file: a labeled handoff list, counted per download.
  const [download] = await Promise.all([page.waitForEvent("download"), batch.getByRole("link", { name: "Download file (CSV)" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^billing-handoff-B-\d{4}-\d{4}\.csv$/);
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv.split("\r\n")[0]).toMatch(/^format,batch_number,batch_reference,order_number/);
  expect(csv).toContain(`tlt-billing-handoff-v1`);
  expect(csv).toContain(f.orderNumber);
  expect(csv).toContain(ticket.ticket_number);
  await page.reload();
  await expect(batch.getByRole("link", { name: "Download again (CSV)" })).toBeVisible();
  await expect(batch.getByText(/file downloaded 1×/)).toBeVisible();

  // 6. Undo with a reason; the history keeps both decisions.
  await batch.getByRole("row").filter({ hasText: f.orderNumber }).getByRole("button", { name: "Undo handoff" }).click();
  await page.getByRole("dialog").getByLabel("Reason").fill("Handed off too early (e2e)");
  await page.getByRole("dialog").getByRole("button", { name: "Undo handoff" }).click();
  await expectToast(page, "Handoff undone. The order is back in billing review.");
  await page.goto(`/billing/orders/${f.orderId}`);
  await expect(page.getByText("Ready to bill", { exact: true }).first()).toBeVisible();
  const history = page.getByRole("list", { name: "Billing history" });
  await expect(history.getByText("Undone", { exact: true })).toBeVisible();
  await expect(history.getByText(/Handed off too early \(e2e\)/)).toBeVisible();
  await expect(history.getByText(/Customer confirmed partial delivery \(e2e\)/)).toBeVisible();
  await expect(page.getByRole("link", { name: ticket.ticket_number })).toBeVisible();
});

test("dispatchers do not see billing", async ({ page }) => {
  await signIn(page, "dispatcher");
  await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);
  await page.goto("/billing");
  await expect(page).toHaveURL(/no-access/);
});
