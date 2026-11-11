import "server-only";
import { yearSummary, type YearInvoice, type YearTicketPayment } from "@/lib/accounting/year";
import { quarterRange } from "@/lib/fuel/ifta";
import { allRows } from "@/server/data/all-rows";
import { listInvoices } from "@/server/data/invoices";
import { loadFuel } from "@/server/data/fuel";
import { createClient } from "@/server/supabase/server";

// Accountant view (B134): a year of the company's financial records, read with the person's own session. The database
// decides what is visible: billing.view for invoices and settlements, accounting.view for fuel, and payroll only when
// the accountant's invite includes it (accountant_payroll_periods). Nothing is computed that the records do not hold.

export interface AccountantMe { role: string; ends_at: string | null; payroll: boolean }
export interface PayrollPeriod { id: string; starts_on: string; ends_on: string; status: string; drivers: Array<{ driver_id: string; name: string; gross_cents: number }> }

export async function accountantMe(): Promise<AccountantMe | null> {
  const { data, error } = await (await createClient()).rpc("accountant_me");
  return error ? null : ((data as AccountantMe | null) ?? null);
}

export async function recordAccountantVisit(section: string): Promise<void> {
  await (await createClient()).rpc("accountant_record_visit", { p_section: section });
}

type TicketPaymentRow = { id: string; amount_cents: number | string; received_on: string; method: string; reference: string; voided_at: string | null; customers: { name: string } | null };

/**
 * Payments recorded by ticket (Billing → Payments by ticket, 20261120009400) received in the year, read in pages so a
 * busy year is never cut short. billing.view (RLS); none before that update is installed.
 */
async function ticketPayments(year: number): Promise<YearTicketPayment[] | null> {
  const supabase = await createClient();
  const { data, error } = await allRows<TicketPaymentRow>(() => supabase.from("customer_payments").select("id, amount_cents, received_on, method, reference, voided_at, customers(name)")
    .gte("received_on", `${year}-01-01`).lte("received_on", `${year}-12-31`).order("received_on").order("id"));
  // Not installed yet (before 20261120009400): nothing to count. Any other failure: null, so Collected says what is
  // missing instead of quietly leaving those payments out (honest data).
  if (error) return ["PGRST205", "42P01"].includes(error.code ?? "") ? [] : null;
  return (data ?? []).map((p) => ({ id: p.id, amount_cents: Number(p.amount_cents), received_on: p.received_on, method: p.method, reference: p.reference, voided_at: p.voided_at, customer_name: p.customers?.name ?? "Customer" }));
}

export async function loadAccountingYear(year: number, today: string, withPayroll: boolean) {
  const supabase = await createClient();
  const [invoices, byTicket, settlements, quarters, payroll] = await Promise.all([
    listInvoices(),
    // Payments recorded by ticket (Billing → Payments by ticket, 20261120009400), received in the year: money collected
    // even where it is not on an invoice yet. billing.view (RLS); none before that update is installed.
    ticketPayments(year),
    supabase.from("hauler_settlements").select("id, number, status, period_start, period_end, gross_cents, commission_cents, deductions_cents, net_cents, paid_on, haulers(name)")
      .gte("period_end", `${year}-01-01`).lte("period_start", `${year}-12-31`).neq("status", "void").order("period_start").limit(500),
    Promise.all([1, 2, 3, 4].map(async (q) => {
      const { from, to } = quarterRange(year, q);
      const f = from > today ? null : await loadFuel(from, to).catch(() => null);
      return { quarter: q, from, to, installed: Boolean(f?.installed), miles: f?.summary.miles ?? 0, gallons: f?.summary.gallons ?? 0, mpg: f?.summary.mpg ?? null, future: from > today };
    })),
    withPayroll ? supabase.rpc("accountant_payroll_periods").then((r) => (r.error ? null : (r.data as PayrollPeriod[]))) : Promise.resolve(null),
  ]);
  const shaped: YearInvoice[] = (invoices ?? []).map((i) => ({
    id: i.id, number: i.number, status: i.status, customer_name: i.customer_name, order_number: i.order_number, issue_date: i.issue_date,
    due_date: i.due_date, total_cents: i.total_cents, tax_cents: Number(i.tax_cents ?? 0),
    payments: i.payments.map((p) => ({ amount_cents: p.amount_cents, received_on: p.received_on, method: p.method, reference: p.reference, voided_at: p.voided_at, customer_payment_id: p.customer_payment_id ?? null })),
  }));
  return {
    invoicesInstalled: invoices !== null,
    summary: yearSummary(shaped, year, today, byTicket),
    settlements: settlements.error ? null : ((settlements.data ?? []) as unknown as Array<{ id: string; number: string; status: string; period_start: string; period_end: string; gross_cents: number; commission_cents: number; deductions_cents: number; net_cents: number; paid_on: string | null; haulers: { name: string } | null }>),
    quarters,
    payroll: payroll?.filter((p) => p.starts_on <= `${year}-12-31` && p.ends_on >= `${year}-01-01`) ?? null,
  };
}
