import { csvCell } from "@/lib/billing/rules";

// Accountant view (B134): a year's invoices and payments summarized from the company's own records. Nothing is
// estimated: void invoices and voided payments are left out, and an invoice without an issue date is not invoiced yet.

export interface YearInvoice {
  id: string; number: string | null; status: string; customer_name: string; order_number: string;
  issue_date: string | null; due_date: string | null; total_cents: number; tax_cents: number;
  payments: Array<{ amount_cents: number; received_on: string; method: string; reference: string; voided_at: string | null }>;
}

export const AGING = ["Not due", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"] as const;

const paidOf = (i: YearInvoice, until?: string) => i.payments.filter((p) => !p.voided_at && (!until || p.received_on <= until)).reduce((n, p) => n + p.amount_cents, 0);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function yearSummary(invoices: YearInvoice[], year: number, today: string) {
  const inYear = (d: string | null) => Boolean(d && d.startsWith(`${year}-`));
  const live = invoices.filter((i) => i.status !== "void" && i.issue_date);
  const issued = live.filter((i) => inYear(i.issue_date));
  const payments = live.flatMap((i) => i.payments.filter((p) => !p.voided_at && inYear(p.received_on)).map((p) => ({ ...p, invoice: i })))
    .sort((a, b) => a.received_on.localeCompare(b.received_on));
  const aging = AGING.map((label) => ({ label, count: 0, cents: 0 }));
  for (const i of live) {
    const open = i.total_cents - paidOf(i);
    if (open <= 0) continue;
    const late = i.due_date ? days(i.due_date, today) : 0;
    const b = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4;
    aging[b].count += 1;
    aging[b].cents += open;
  }
  return {
    issued: issued.sort((a, b) => (a.issue_date ?? "").localeCompare(b.issue_date ?? "") || (a.number ?? "").localeCompare(b.number ?? "")),
    invoicedCents: issued.reduce((n, i) => n + i.total_cents, 0),
    taxCents: issued.reduce((n, i) => n + i.tax_cents, 0),
    payments,
    receivedCents: payments.reduce((n, p) => n + p.amount_cents, 0),
    outstandingCents: aging.reduce((n, a) => n + a.cents, 0),
    aging,
  };
}

const money = (c: number) => (c / 100).toFixed(2);
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function invoicesCsv(s: ReturnType<typeof yearSummary>): string {
  return csv([["Invoice", "Issue date", "Due date", "Customer", "Order", "Status", "Tax", "Total", "Paid to date", "Open"],
    ...s.issued.map((i) => { const paid = paidOf(i); return [i.number ?? "", i.issue_date, i.due_date ?? "", i.customer_name, i.order_number, i.status, money(i.tax_cents), money(i.total_cents), money(paid), money(Math.max(0, i.total_cents - paid))]; })]);
}

export function paymentsCsv(s: ReturnType<typeof yearSummary>): string {
  return csv([["Received", "Invoice", "Customer", "Method", "Reference", "Amount"],
    ...s.payments.map((p) => [p.received_on, p.invoice.number ?? "", p.invoice.customer_name, p.method, p.reference, money(p.amount_cents)])]);
}

/** Tax season default: until the end of April the accountant usually works on last year. */
export function defaultYear(today: string): number {
  const [y, m] = today.split("-").map(Number);
  return m <= 4 ? y - 1 : y;
}
