import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Revenue check (B110, migration 20261120005100): an order delivered 25 t against 22 t ordered and handed off at 22 t
// shows as "Billed less than delivered" ($30 at $10/t); the owner marks it fine with a reason, finds it under Checked,
// and shows it again. Nothing is billed or changed. Fictional data only.

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;

/** A completed order (one gravel line) with an accepted ticket, acknowledged and handed off for billing. */
async function handedOff(deliveredTons: string) {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const far = (await q("select ($1::date + 600)::text as d", [today])).rows[0].d as string;
    const truck = await ins("trucks", { unit_number: `RCK-${id}`, truck_type: "tri_axle_dump" });
    const driver = await ins("drivers", { name: `Rex Driver ${id}` });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driver, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
    await ins("driver_qualifications", { driver_id: driver, kind: "medical_card", expires_on: far, verified_at: verified });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const o = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: yesterday, project_name: `Revenue check e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "22", unit_rate_cents: 1000 }],
    })])).rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: yesterday, start_time: "07:00", end_time: "09:00", planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
    await q("select public.assign_load($1, $2, null, $3, '', null)", [load, truck, driver]);
    const line = (await q("select id from public.order_lines where order_id = $1 and line_no = 1", [o.order_id])).rows[0].id as string;
    const t = (await q("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({ load_id: load, order_line_id: line, delivered_date: yesterday, delivered_time: "08:30", quantity: deliveredTons, unit_code: "ton", external_reference: `RC-${id}` })])).rows[0].r as { ticket_id: string };
    await q("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
    await q("select public.set_order_status($1, 'in_progress', '')", [o.order_id]);
    await q("select public.set_order_status($1, 'completed', '')", [o.order_id]);
    const st = (await q("select exceptions_fingerprint, readiness from public.billing_order_status where order_id = $1", [o.order_id])).rows[0];
    if (st?.readiness !== "ready" && st?.exceptions_fingerprint) await q("select public.acknowledge_billing_exceptions($1, $2, 'e2e')", [o.order_id, st.exceptions_fingerprint]);
    await q("select public.hand_off_orders($1::uuid[], 'Revenue check e2e', '', $2)", [[o.order_id], randomUUID()]);
    return o.order_number;
  });
}

test("the owner finds an under-billed order, marks it checked and shows it again", async ({ page }) => {
  test.slow();
  const orderNumber = await handedOff("25");
  await signIn(page, "owner");
  await page.goto("/billing/leaks");
  const section = page.getByRole("list", { name: "Billed less than delivered" });
  const row = section.getByRole("listitem", { name: new RegExp(`${orderNumber} `) });
  await expect(row).toContainText("billed 22 ton, tickets show 25");
  await expect(row).toContainText("$30.00");
  await expect(row.getByRole("link", { name: "Revert the handoff and correct the order" })).toHaveAttribute("href", /\/orders\//);

  await row.getByRole("button", { name: `Mark ${orderNumber} as checked` }).click();
  const dialog = page.getByRole("form", { name: "Mark as checked" });
  await dialog.getByLabel("Why is this fine?").fill("Customer agreed to 22 t (e2e)");
  await dialog.getByRole("button", { name: "Mark as checked" }).click();
  await expectToast(page, "Marked as checked");
  await expect(page.getByRole("listitem", { name: new RegExp(`${orderNumber} Billed less`) })).toHaveCount(0);

  await page.getByRole("link", { name: /^Checked/ }).click();
  const checked = page.getByRole("listitem", { name: new RegExp(`${orderNumber} Billed less`) });
  await expect(checked).toContainText("Checked: Customer agreed to 22 t (e2e)");
  await checked.getByRole("button", { name: "Show again" }).click();
  await expectToast(page, "Shown again.");
  await page.goto("/billing/leaks");
  await expect(page.getByRole("listitem", { name: new RegExp(`${orderNumber} Billed less`) })).toHaveCount(1);
});
