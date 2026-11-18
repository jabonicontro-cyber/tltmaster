import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { driverFixture } from "./driver-fixture";
import { createClient } from "@supabase/supabase-js";
import { closeDemoWelcomeIfShown, signIn } from "./helpers";
import { USERS } from "./users";

// Owner decisions 2026-11-14 to 11-17, batch C: totals for money access only (SEC7), the invoicing question (INV1), the
// PO on acceptance and invoices overdue but never sent (BL1), Billing and Order to Cash (O2C1), and the driver's
// "Mistake on my ticket" on a phone, also without signal (TM1). Top Line's shared e2e users; anything changed for a test
// is put back.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

test.describe.configure({ mode: "serial" });

test("SEC7: a dispatcher sees the rates on an order but no totals; the office sees the totals", async ({ page }) => {
  const [o] = await sql<{ id: string; order_number: string; total: string }>(
    `select o.id, o.order_number, o.total_cents::text total from public.orders o
      where o.company_id = $1 and o.status <> 'canceled' and o.total_cents > 0
        and exists (select 1 from public.order_lines l where l.order_id = o.id and l.calc_method = 'per_unit' and l.unit_rate_cents > 0)
        -- The total must not read like one of its rates (a one-unit line), so "not on the page" means the total.
        and not exists (select 1 from public.order_lines l where l.order_id = o.id and (l.unit_rate_cents = o.total_cents or l.quantity = 1))
      order by o.created_at desc limit 1`, [TOP_LINE]);
  test.skip(!o, "needs a Top Line order with a priced line");
  const money = (Number(o.total) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

  await signIn(page, "dispatcher");
  await page.goto(`/orders/${o.id}`);
  await expect(page.getByRole("heading", { name: o.order_number, level: 1 })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Rate" }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Amount" })).toHaveCount(0);
  await expect(page.getByTestId("totals-hidden")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(money);
  await page.goto("/orders");
  await expect(page.getByRole("columnheader", { name: "Total" })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, "office");
  await page.goto(`/orders/${o.id}`);
  await expect(page.getByRole("columnheader", { name: "Amount" }).first()).toBeVisible();
  await expect(page.getByTestId("totals-hidden")).toHaveCount(0);
  await expect(page.locator("main")).toContainText(money);
});

test("INV1: until the company answers, Getting started and Billing ask who sends the invoices", async ({ page }) => {
  const [before] = await sql<{ issuer: string; chosen: string | null }>("select issuer, issuer_chosen_at::text chosen from public.invoicing_settings where company_id = $1", [TOP_LINE]);
  await sql("update public.invoicing_settings set issuer_chosen_at = null where company_id = $1", [TOP_LINE]);
  await sql("delete from public.user_preferences where company_id = $1 and key = 'getting_started' and user_id = (select id from auth.users where email = $2)", [TOP_LINE, USERS.owner.email]);
  try {
    await signIn(page, "owner");
    await page.goto("/command-center");
    const step = page.getByTestId("getting-started").getByRole("link", { name: /Who sends your invoices: Taviron or QuickBooks\?/ });
    await expect(step).toHaveAttribute("href", "/settings?tab=invoicing#issuer");
    await page.goto("/billing");
    await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
    const question = page.getByTestId("invoicing-choice");
    await expect(question.getByRole("heading", { name: "Who sends your invoices: Taviron or QuickBooks?" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Businesses and QuickBooks" })).toHaveCount(0);
    // Billing → Businesses and QuickBooks shows the question, not empty QuickBooks screens.
    await page.goto("/billing/setup");
    await expect(page.getByTestId("invoicing-choice")).toBeVisible();
    // Answered on Billing: the question goes away.
    await page.goto("/billing");
    await question.getByLabel(/QuickBooks/).check();
    await question.getByRole("button", { name: "Save" }).click();
    await page.waitForURL(/\/billing\?saved=invoicing/);
    await expect(page.getByTestId("invoicing-choice")).toHaveCount(0);
    // Settings → Invoicing: one Save for the choice, one for the invoice details.
    await page.goto("/settings?tab=invoicing");
    await expect(page.getByRole("form", { name: "Who sends your invoices" }).getByRole("button", { name: "Save" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Invoice details" }).getByRole("button", { name: "Save" })).toBeVisible();
  } finally {
    await sql("update public.invoicing_settings set issuer = $2, issuer_chosen_at = $3::timestamptz where company_id = $1", [TOP_LINE, before?.issuer ?? "quickbooks", before?.chosen ?? new Date().toISOString()]);
  }
});

test("BL1: accepting a quote for a PO-required customer asks for the PO and puts it on the order", async ({ page }) => {
  const po = `PO-${randomUUID().slice(0, 6)}`;
  const quote = await asUser(USERS.office.email, async (q) => {
    const cust = (await q("select id from public.customers where name = 'Lakeshore Paving Co.' and company_id = $1", [TOP_LINE])).rows[0];
    const mat = (await q("select id from public.materials where code = 'GRV-53' and company_id = $1", [TOP_LINE])).rows[0];
    const today = (await q("select current_date::text d")).rows[0].d as string;
    // The customer's own price for the material (a contract customer), so the office needs no override.
    const price = (await q("select rate_cents from public.effective_prices($1, $2) where material_id = $3 and unit_code = 'ton'", [cust.id, today, mat.id])).rows[0];
    const r = (await q("select public.save_quote_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: cust.id, quote_date: today, valid_until: today, project_name: `PO prompt e2e ${po}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mat.id, description: "Gravel #53", unit_code: "ton", quantity: "10", unit_rate_cents: Number(price?.rate_cents ?? 1000) }],
    })])).rows[0].r as { quote_id: string; edit_seq: number; quote_number: string };
    await q("select public.mark_quote_sent($1, $2, 'Handed over (e2e)')", [r.quote_id, r.edit_seq]);
    return r;
  });
  await signIn(page, "office");
  await page.goto(`/quotes/${quote.quote_id}`);
  await page.getByRole("button", { name: "Mark accepted" }).click();
  const ask = page.getByTestId("accept-po");
  await expect(ask).toContainText("This customer needs a PO number");
  await ask.getByLabel("Customer PO number").fill(po);
  await page.getByRole("dialog").getByRole("button", { name: "Mark accepted" }).click();
  await expect(page.getByText(/Quote marked accepted/)).toBeVisible();
  await expect.poll(async () => (await sql<{ customer_po: string }>("select customer_po from public.orders where source_quote_id = $1", [quote.quote_id]))[0]?.customer_po).toBe(po);
});

test("O2C1: Billing is the daily work list and links to the read-only Order to Cash overview", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/billing");
  await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "See all orders from delivery to payment" }).click();
  await expect(page.getByRole("heading", { name: "Order to Cash", level: 1 })).toBeVisible();
  await expect(page.getByText(/A read-only overview of every order from delivery to payment/)).toBeVisible();
  const stages = page.getByRole("list", { name: "Stages" });
  await expect(stages).toContainText("Invoiced");
  await expect(stages).toContainText("Paid");
  await expect(page.getByRole("link", { name: "Your daily billing work is in Billing" })).toHaveAttribute("href", "/billing");
});

test("BL1: an invoice overdue but never sent is flagged on the list and the invoice, with the next steps", async ({ page }) => {
  // The presenter demo's sample invoice past due and never sent, read by an office sign-in made for this run (demo data).
  const [inv] = await sql<{ id: string; company_id: string }>(
    `select i.id, i.company_id from public.invoices i join public.companies c on c.id = i.company_id
      where c.is_demo and c.active and i.status = 'issued' and i.sent_at is null and i.due_date < current_date
        and i.total_cents > coalesce((select sum(p.amount_cents) from public.invoice_payments p where p.invoice_id = i.id and p.voided_at is null), 0)
      order by c.created_at desc limit 1`);
  test.skip(!inv, "needs a demo company with an invoice overdue and never sent");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const password = `Pw-${randomUUID()}`;
  const email = `e2e-c-office-${randomUUID().slice(0, 6)}@demotest.example`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Rita Ledger" } });
  if (error) throw error;
  await admin.from("profiles").update({ full_name: "Rita Ledger", active_company_id: inv.company_id }).eq("id", data.user.id);
  await admin.from("company_memberships").insert({ company_id: inv.company_id, user_id: data.user.id, role: "office", active: true });
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await closeDemoWelcomeIfShown(page);
  await page.goto("/billing/invoices");
  await expect(page.getByTestId("never-sent-notice")).toBeVisible();
  await page.goto(`/billing/invoices/${inv.id}`);
  const warn = page.getByTestId("never-sent-warning");
  await expect(warn).toContainText("Overdue, but never sent");
  await expect(warn.getByRole("link", { name: "Send it now" })).toHaveAttribute("href", "#send-email");
});

test("TM1: a driver reports a mistake on a sent ticket from the phone, also without signal; it reaches ticket review", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await driverFixture();
  const paper = `PAPER-${randomUUID().slice(0, 5)}`;
  const paper2 = `PAPER-${randomUUID().slice(0, 5)}`;
  // Two tickets sent from the phone earlier (the driver's own session): yesterday's load and today's late load.
  const sent = await asUser(USERS.driver.email, async (q) => {
    const form = async (assignment: string) => (await q("select public.driver_assignment_form($1) as r", [assignment])).rows[0].r as { lines: Array<{ id: string }>; load: { date: string } };
    const submit = async (assignment: string, ref: string, time: string) => {
      const fm = await form(assignment);
      return (await q("select public.driver_submit_ticket($1::jsonb) as r", [JSON.stringify({
        assignment_id: assignment, order_line_id: fm.lines[0].id, delivered_date: fm.load.date, delivered_time: time, quantity: "21.5", unit_code: "ton",
        external_reference: ref, notes: "", submission_key: randomUUID(),
      })])).rows[0].r as { ticket_id: string; ticket_number: string };
    };
    return { past: await submit(f.past, paper, "08:30"), late: await submit(f.late, paper2, "00:05") };
  });

  await signIn(page, "driver");
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible({ timeout: 30_000 });
  // The paper ticket number shows after sending.
  const recent = page.getByRole("list", { name: /My recent/ });
  await expect(recent).toContainText(`paper ${paper}`);
  await recent.getByRole("listitem").filter({ hasText: sent.past.ticket_number }).getByRole("link", { name: /Mistake on my ticket/ }).click();
  await expect(page.getByRole("heading", { name: `Mistake on ticket ${sent.past.ticket_number}` })).toBeVisible();
  await page.getByLabel("The quantity").check();
  await page.getByLabel(/The right quantity/).fill("22.5");
  await page.getByLabel("Note for the office (optional)").fill("Scale ticket says 22.5 (e2e)");
  await page.getByRole("button", { name: "Send to the office" }).click();
  await expect(page.getByTestId("sent-confirmation")).toContainText(`Mistake on ticket ${sent.past.ticket_number} sent to the office`);
  await expect(page.getByRole("list", { name: /My recent/ }).getByRole("listitem").filter({ hasText: sent.past.ticket_number }).getByTestId("mistake-reported")).toBeVisible();

  // Without signal: from the day kept on the phone, the report waits and sends itself once signal returns.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("taviron-offline-day")), { timeout: 20_000 }).toContain(sent.late.ticket_number);
  await context.setOffline(true);
  await page.goto("/driver").catch(() => undefined);
  await expect(page.getByText(/Your day as of .*No connection/)).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`Mistake on ticket ${sent.late.ticket_number}`) }).click();
  await page.getByLabel("The ticket number").check();
  await page.getByLabel(/The right ticket number/).fill("4471");
  await page.getByRole("button", { name: "Send to the office" }).click();
  await expect(page.getByTestId("mistake-queued")).toContainText("Saved on this phone");
  await context.setOffline(false);
  await page.goto("/driver");
  await expect.poll(async () => (await sql<{ n: number }>("select count(*)::int n from public.ticket_mistake_reports where ticket_number = $1 and correct_value = '4471'", [sent.late.ticket_number]))[0].n, { timeout: 30_000 }).toBe(1);

  // The office's ticket review shows both; the ticket shows its report with the next step.
  await page.context().clearCookies();
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page, "office");
  await page.goto("/tickets?view=check");
  const queue = page.getByTestId("mistake-reports");
  await expect(queue).toContainText(sent.past.ticket_number);
  await expect(queue).toContainText("Quantity should be 22.5");
  await queue.getByRole("link", { name: sent.past.ticket_number }).click();
  await expect(page.getByTestId("mistake-reports")).toContainText("Scale ticket says 22.5 (e2e)");
  await expect(page.getByRole("link", { name: "Correct the ticket" })).toBeVisible();
});
