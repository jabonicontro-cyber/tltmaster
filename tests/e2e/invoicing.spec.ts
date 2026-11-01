import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

// Invoicing (B99, migration 20261120004800): with Taviron issuing, the office creates an invoice from a handed-off
// order, issues it (numbered INV-…), emails it (a preview on servers without email set up) and records a partial
// payment; Invoices shows it as partly paid. The company is put back to QuickBooks afterwards.

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;

/** A completed order (one gravel line) with an accepted ticket, acknowledged and handed off for billing. */
async function handedOff() {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const far = (await q("select ($1::date + 600)::text as d", [today])).rows[0].d as string;
    const truck = await ins("trucks", { unit_number: `INV-${id}`, truck_type: "tri_axle_dump" });
    const driver = await ins("drivers", { name: `Ivy Driver ${id}` });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driver, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
    await ins("driver_qualifications", { driver_id: driver, kind: "medical_card", expires_on: far, verified_at: verified });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const o = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: yesterday, project_name: `Invoice e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "22", unit_rate_cents: 1000 }],
    })])).rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: yesterday, start_time: "07:00", end_time: "09:00", planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
    await q("select public.assign_load($1, $2, null, $3, '', null)", [load, truck, driver]);
    const line = (await q("select id from public.order_lines where order_id = $1 and line_no = 1", [o.order_id])).rows[0].id as string;
    const t = (await q("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({ load_id: load, order_line_id: line, delivered_date: yesterday, delivered_time: "08:30", quantity: "22", unit_code: "ton", external_reference: `IV-${id}` })])).rows[0].r as { ticket_id: string };
    await q("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
    await q("select public.set_order_status($1, 'in_progress', '')", [o.order_id]);
    await q("select public.set_order_status($1, 'completed', '')", [o.order_id]);
    const st = (await q("select exceptions_fingerprint, readiness from public.billing_order_status where order_id = $1", [o.order_id])).rows[0];
    if (st?.readiness !== "ready" && st?.exceptions_fingerprint) await q("select public.acknowledge_billing_exceptions($1, $2, 'e2e')", [o.order_id, st.exceptions_fingerprint]);
    await q("select public.hand_off_orders($1::uuid[], 'Invoice e2e', '', $2)", [[o.order_id], randomUUID()]);
    return o.order_number;
  });
}

test("the office invoices a handed-off order, emails it and records a partial payment", async ({ page }) => {
  test.slow();
  const orderNumber = await handedOff();
  await office(async (q) => { await q("select public.invoicing_save_settings('taviron', 30, 'Thank you (e2e)')"); });
  try {
    await signIn(page, "office");
    await page.goto("/billing?view=handed_off");
    const row = page.getByRole("row").filter({ hasText: orderNumber });
    await row.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.getByRole("heading", { name: "Draft invoice", level: 1 })).toBeVisible();
    await expect(page.getByRole("table", { name: "Invoice lines" })).toContainText("Gravel #53 limestone");

    await page.getByRole("button", { name: "Issue invoice" }).click();
    await expect(page.getByText(/Issued\. The invoice is numbered and locked/)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Invoice INV-\d{4,}$/);

    await page.getByRole("textbox", { name: "To", exact: true }).fill("ap@prairieview.example");
    await page.getByRole("button", { name: "Send invoice" }).click();
    await expect(page.getByText(/Preview only — nothing was sent|Test mode: the email went to the test inbox|Emailed to the customer/)).toBeVisible();

    const pay = page.getByRole("form", { name: "Record a payment" });
    await pay.getByLabel("Amount ($)").fill("100.00");
    await pay.getByLabel("Check or reference number").fill("4521");
    await pay.getByRole("button", { name: "Record payment" }).click();
    await expect(page.getByText("Payment recorded.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Payments" })).toContainText("$100.00");
    await expect(page.getByRole("list", { name: "Payments" })).toContainText("Check #4521");

    await page.goto("/billing/invoices?view=partly_paid");
    await expect(page.getByRole("table", { name: "Invoices" }).getByRole("row").filter({ hasText: orderNumber })).toContainText("Partly paid");
    await expect(page.getByRole("table", { name: "Receivables by age" })).toContainText("Prairie View Landscaping");
  } finally {
    await office(async (q) => { await q("select public.invoicing_save_settings('quickbooks', 30, '')"); });
  }
});

test("dispatchers cannot open invoices", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/billing/invoices");
  await expect(page).toHaveURL(/no-access/);
});
