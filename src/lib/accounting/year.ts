import { csvCell } from "@/lib/billing/rules";

// Accountant view (B134): a year's invoices and payments summarized from the company's own records. Nothing is
// estimated: void invoices and voided payments are left out, and an invoice without an issue date is not invoiced yet.
//
// Two different figures, each named for what it counts (owner walkthrough WK1, "issued instead of paid"):
//   - Invoiced in the year: invoices issued in the year (billed, whether paid or not; accrual view).
//   - Collected in the year: money actually received in the year (cash view), each payment once: a payment recorded on an
//     invoice, plus a payment recorded by ticket (Billing → Payments by ticket, TP1) for its whole amount, including any
//     part not on an invoice yet. The invoice payments a payment by ticket created (invoice_payments.customer_payment_id)
//     are part of that payment and not counted again.

export interface YearInvoicePayment {
  amount_cents: number; received_on: string; method: string; reference: string; voided_at: string | null;
  /** Set when the payment was recorded by ticket and applied to this invoice (20261120009400). */
  customer_payment_id?: string | null;
}

export interface YearInvoice {
  id: string; number: string | null; status: string; customer_name: string; order_number: string;
  issue_date: string | null; due_date: string | null; total_cents: number; tax_cents: number;
  payments: YearInvoicePayment[];
}

/** A payment recorded by ticket (customer_payments): the money received, whether or not it is on an invoice yet. */
export interface YearTicketPayment {
  id: string; customer_name: string; amount_cents: number; received_on: string; method: string; reference: string; voided_at: string | null;
}

/** One payment received in the year, as the accountant lists it. */
export interface ReceivedPayment {
  received_on: string;
  /** The invoice number(s) it paid; empty when none yet. */
  invoices: string;
  customer_name: string;
  method: string;
  reference: string;
  amount_cents: number;
  /** "invoice": recorded on an invoice; "by_ticket": recorded by ticket (Payments by ticket). */
  source: "invoice" | "by_ticket";
  /** For a payment by ticket: the part not applied to an invoice yet (credit or tickets not invoiced). */
  not_on_invoice_cents: number;
}

export const AGING = ["Not due", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"] as const;

const live = (p: { voided_at: string | null }) => !p.voided_at;
const paidOf = (i: YearInvoice, until?: string) => i.payments.filter((p) => live(p) && (!until || p.received_on <= until)).reduce((n, p) => n + p.amount_cents, 0);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function yearSummary(invoices: YearInvoice[], year: number, today: string, byTicket: YearTicketPayment[] | null = []) {
  const inYear = (d: string | null) => Boolean(d && d.startsWith(`${year}-`));
  const liveInvoices = invoices.filter((i) => i.status !== "void" && i.issue_date);
  const issued = liveInvoices.filter((i) => inYear(i.issue_date));
  // Received in the year, each payment once.
  const direct: ReceivedPayment[] = liveInvoices.flatMap((i) => i.payments
    // Payments by ticket are counted once below; when they could not be read, their invoice side still counts here.
    .filter((p) => live(p) && (!p.customer_payment_id || byTicket === null) && inYear(p.received_on))
    .map((p) => ({ received_on: p.received_on, invoices: i.number ?? "", customer_name: i.customer_name, method: p.method, reference: p.reference, amount_cents: p.amount_cents, source: "invoice" as const, not_on_invoice_cents: 0 })));
  const ticketPayments: ReceivedPayment[] = (byTicket ?? []).filter((p) => live(p) && inYear(p.received_on)).map((p) => {
    const applied = liveInvoices.flatMap((i) => i.payments.filter((x) => live(x) && x.customer_payment_id === p.id).map((x) => ({ number: i.number ?? "", cents: x.amount_cents })));
    const onInvoices = applied.reduce((n, a) => n + a.cents, 0);
    return {
      received_on: p.received_on, invoices: [...new Set(applied.map((a) => a.number).filter(Boolean))].join(" "), customer_name: p.customer_name,
      method: p.method, reference: p.reference, amount_cents: p.amount_cents, source: "by_ticket" as const, not_on_invoice_cents: Math.max(0, p.amount_cents - onInvoices),
    };
  });
  const received = [...direct, ...ticketPayments].sort((a, b) => a.received_on.localeCompare(b.received_on) || a.invoices.localeCompare(b.invoices));
  const aging = AGING.map((label) => ({ label, count: 0, cents: 0 }));
  for (const i of liveInvoices) {
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
    /** Every payment received in the year, each once (Collected). */
    received,
    /** Collected in the year: the sum of received. */
    receivedCents: received.reduce((n, p) => n + p.amount_cents, 0),
    /** Of that, money received by ticket that is not on an invoice yet (credit, or tickets not invoiced). */
    notOnInvoiceCents: received.reduce((n, p) => n + p.not_on_invoice_cents, 0),
    /** Payments by ticket could not be read: money received by ticket and not on an invoice yet may be missing. */
    ticketPaymentsMissing: byTicket === null,
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

/** Payments received in the year: the rows behind "Collected", each payment once. */
export function paymentsCsv(s: ReturnType<typeof yearSummary>): string {
  return csv([["Received", "Invoice", "Customer", "Method", "Reference", "Amount", "Recorded", "Not on an invoice yet"],
    ...s.received.map((p) => [p.received_on, p.invoices, p.customer_name, p.method, p.reference, money(p.amount_cents), p.source === "by_ticket" ? "By ticket" : "On the invoice", money(p.not_on_invoice_cents)]),
    // Said in the file too, so a download never looks complete when it is not.
    ...(s.ticketPaymentsMissing ? [["Payments by ticket could not be read: money received by ticket and not on an invoice yet is missing from this file. Download again.", "", "", "", "", "", "", ""]] : [])]);
}

/** Tax season default: until the end of April the accountant usually works on last year. */
export function defaultYear(today: string): number {
  const [y, m] = today.split("-").map(Number);
  return m <= 4 ? y - 1 : y;
}
