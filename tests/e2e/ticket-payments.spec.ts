import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Payments by delivery ticket (TP1, migration 20261120009400): a customer pays against ticket numbers. The office finds
// the tickets from the numbers on the check stub, pays one in full and one in part, keeps the rest as credit, applies
// the credit later and voids the payment, which reopens the tickets. QuickBooks issuer (the default): Taviron only.

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;
const TOP_LINE = "00000000-0000-4000-8000-000000000001";

/** A completed order with two accepted tickets (12 and 10 tons), handed off for billing. */
async function twoTicketOrder() {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const far = (await q("select ($1::date + 600)::text as d", [today])).rows[0].d as string;
    const truck = await ins("trucks", { unit_number: `TP-${id}`, truck_type: "tri_axle_dump" });
    const driver = await ins("drivers", { name: `Tess Driver ${id}` });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driver, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
    await ins("driver_qualifications", { driver_id: driver, kind: "medical_card", expires_on: far, verified_at: verified });
    const customer = (await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE])).rows[0].id as string;
    const mat = (await q("select id from public.materials where code = 'GRV-53' and company_id = $1", [TOP_LINE])).rows[0].id as string;
    const o = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "200 Ticket Pay Rd (test)", customer_id: customer, order_date: yesterday, project_name: `Ticket pay e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mat, description: "Gravel #53 limestone", unit_code: "ton", quantity: "22", unit_rate_cents: 1000 }],
    })])).rows[0].r as { order_id: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: yesterday, start_time: "07:00", end_time: "11:00", planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
    await q("select public.assign_load($1, $2, null, $3, '', null)", [load, truck, driver]);
    const line = (await q("select id from public.order_lines where order_id = $1 and line_no = 1", [o.order_id])).rows[0].id as string;
    const tickets: string[] = [];
    for (const [qty, time] of [["12", "08:30"], ["10", "10:15"]]) {
      const t = (await q("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({ load_id: load, order_line_id: line, delivered_date: yesterday, delivered_time: time, quantity: qty, unit_code: "ton", external_reference: `TP-${id}-${qty}`, confirm_duplicate: tickets.length > 0 })])).rows[0].r as { ticket_id: string };
      await q("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
      tickets.push((await q("select ticket_number from public.delivery_tickets where id = $1", [t.ticket_id])).rows[0].ticket_number as string);
    }
    await q("select public.set_order_status($1, 'in_progress', '')", [o.order_id]);
    await q("select public.set_order_status($1, 'completed', '')", [o.order_id]);
    const st = (await q("select exceptions_fingerprint, readiness from public.billing_order_status where order_id = $1", [o.order_id])).rows[0];
    if (st?.readiness !== "ready" && st?.exceptions_fingerprint) await q("select public.acknowledge_billing_exceptions($1, $2, 'e2e')", [o.order_id, st.exceptions_fingerprint]);
    await q("select public.hand_off_orders($1::uuid[], 'Ticket pay e2e', '', $2)", [[o.order_id], randomUUID()]);
    const b = (await q("select public.customer_ticket_balances($1) as r", [customer])).rows[0].r as { tickets: Array<{ ticket_number: string; open_cents: number }> };
    const open = (n: string) => b.tickets.find((t) => t.ticket_number === n)!.open_cents;
    return { customer, first: tickets[0], second: tickets[1], firstCents: open(tickets[0]), secondCents: open(tickets[1]) };
  });
}

const dollars = (cents: number) => (cents / 100).toFixed(2);
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

test("the office records a payment by ticket numbers, keeps credit, applies it and voids the payment", async ({ page }) => {
  test.slow();
  const o = await twoTicketOrder();
  expect(o.firstCents).toBeGreaterThan(0);
  expect(o.secondCents).toBeGreaterThan(5000);
  await signIn(page, "office");
  await page.goto("/billing");
  await page.getByRole("link", { name: "Payments by ticket" }).click();
  await expect(page.getByRole("heading", { name: "Payments by ticket", level: 1 })).toBeVisible();
  await page.goto(`/billing/payments?customer=${o.customer}`);

  // The check pays the first ticket in full and $50 of the second, with $10 more than the tickets: kept as credit.
  const form = page.getByRole("form", { name: "Record a payment by ticket" });
  await form.getByLabel("Amount received").fill(dollars(o.firstCents + 5000 + 1000));
  await form.getByLabel("Check or bank reference").fill("20417");
  await form.getByLabel("Ticket numbers from the check stub or remittance").fill(`#${o.first.toLowerCase()}, NOPE-404`);
  await form.getByRole("button", { name: "Select these tickets" }).click();
  await expect(form.getByText("Not found among this customer's open tickets: NOPE-404")).toBeVisible();
  await expect(form.getByRole("checkbox", { name: `Pay ticket ${o.first}` })).toBeChecked();
  await form.getByRole("checkbox", { name: `Pay ticket ${o.second}` }).check();
  await form.getByLabel(`Amount for ticket ${o.second}`).fill("50.00");
  await expect(form.getByText("Kept as credit")).toBeVisible();
  await form.getByRole("button", { name: "Record payment" }).click();
  await expectToast(page, /Payment recorded\. \$10\.00 is kept as credit/);

  const payment = page.getByRole("listitem").filter({ hasText: "Check #20417" }).filter({ hasText: money(o.firstCents + 6000) }).first();
  await expect(payment).toContainText("$10.00 credit");
  await expect(payment).toContainText(`${o.first} ${money(o.firstCents)}`);
  await expect(page.getByRole("row").filter({ hasText: o.first }).filter({ hasText: "Paid" }).first()).toBeVisible();

  // The credit goes to the second ticket later.
  await payment.getByRole("link", { name: "Apply credit" }).click();
  await expect(page.getByRole("heading", { name: "Apply credit" })).toBeVisible();
  const apply = page.getByRole("form", { name: "Apply credit to tickets" });
  await apply.getByRole("checkbox", { name: `Pay ticket ${o.second}` }).check();
  await apply.getByLabel(`Amount for ticket ${o.second}`).fill("10.00");
  await apply.getByRole("button", { name: "Apply credit" }).click();
  await expectToast(page, "Credit applied.");
  const applied = page.getByRole("listitem").filter({ hasText: "Check #20417" }).filter({ hasText: money(o.firstCents + 6000) }).first();
  await expect(applied).toContainText("Applied");
  await expect(applied).toContainText(`${o.second} $60.00`);

  // The check bounced: void it and both tickets are open again.
  await applied.getByRole("button", { name: "Void" }).click();
  await applied.getByLabel("Reason to void this payment").fill("Check bounced (e2e)");
  await applied.getByRole("button", { name: "Void payment" }).click();
  await expectToast(page, /Payment voided/);
  await expect(page.getByRole("listitem").filter({ hasText: "Check bounced (e2e)" }).first()).toContainText("Voided");
  const again = page.getByRole("form", { name: "Record a payment by ticket" });
  await expect(again.getByRole("checkbox", { name: `Pay ticket ${o.first}` })).toBeVisible();
  await expect(again.getByRole("row").filter({ hasText: o.second })).toContainText(money(o.secondCents));
});

// Slice 2: the customer's remittance as a CSV file; each listed ticket gets its listed amount, the check amount is the
// file's total, and a line for an unknown ticket is reported instead of applied.
test("the office loads a remittance file: tickets and amounts are filled in, unknown lines are listed", async ({ page }) => {
  test.slow();
  const o = await twoTicketOrder();
  await signIn(page, "office");
  await page.goto(`/billing/payments?customer=${o.customer}`);
  const form = page.getByRole("form", { name: "Record a payment by ticket" });
  const csv = `Invoice,Ticket #,Date,Amount Paid\nINV-77,${o.first},11/02/2026,"${dollars(o.firstCents)}"\nINV-77,${o.second},11/02/2026,40.00\nINV-77,NOPE-404,11/02/2026,5.00\n`;
  await form.getByLabel("Remittance file (CSV)").setInputFiles({ name: "remittance.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(form.getByText(/remittance\.csv: 3 lines, 2 tickets selected .*\$5\.00 is on lines that match no open ticket/)).toBeVisible();
  await expect(form.getByText("Not found among this customer's open tickets: NOPE-404")).toBeVisible();
  // Only matched lines fill the amount; the unknown line's $5.00 is named, not added.
  await expect(form.getByLabel("Amount received")).toHaveValue(dollars(o.firstCents + 4000));
  await expect(form.getByLabel(`Amount for ticket ${o.second}`)).toHaveValue("40.00");
  await form.getByLabel("Check or bank reference").fill("REM-77");
  await form.getByRole("button", { name: "Record payment" }).click();
  await expectToast(page, /Payment recorded\./);
  const payment = page.getByRole("listitem").filter({ hasText: "Check #REM-77" }).first();
  await expect(payment).toContainText(`${o.second} $40.00`);
  // Leave nothing behind for other runs: void it.
  await payment.getByRole("button", { name: "Void" }).click();
  await payment.getByLabel("Reason to void this payment").fill("Test cleanup (e2e)");
  await payment.getByRole("button", { name: "Void payment" }).click();
  await expectToast(page, /Payment voided/);
});

test("a dispatcher cannot open payments by ticket", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/billing/payments");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payments by ticket", level: 1 })).toHaveCount(0);
});
