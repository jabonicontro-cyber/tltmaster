// What a customer owes and what is still on its way to an invoice (first-day office walkthrough 2026-11-09: a customer
// with delivered work and no invoice showed no balance at all). Pure: the loader passes the records billing already
// keeps, each figure keeps its own source, and estimates are labelled as such by the page.

import { balanceCents, invoiceState, type InvoiceLite } from "./invoices";

export type BalanceInvoice = Pick<InvoiceLite, "status" | "total_cents" | "payments" | "due_date">;

export interface BalanceInput {
  today: string;
  /** Issued and void invoices of the customer (drafts are left out by the loader). */
  invoices: BalanceInvoice[];
  /** Handed-off (not undone) orders with their billed total and the status of the invoice that bills them, if any. */
  handoffs: Array<{ total_cents: number; invoice_status: "draft" | "issued" | "void" | null }>;
  /** Orders still in billing review with their value so far: accepted tickets at the order's prices (an estimate). */
  delivered: Array<{ value_cents: number; tickets_pending: number }>;
  /** What is open on billed tickets after payments by ticket (null when not read). */
  ticketsOpenCents: number | null;
  /** Money received and not applied to a ticket yet. */
  creditCents: number;
}

export interface BalanceSummary {
  /** Owed on issued invoices, less payments. */
  owedCents: number;
  overdueCents: number;
  /** Handed off and not on an issued invoice yet (no invoice, or a draft). */
  handedOffCents: number;
  handedOffCount: number;
  /** Handed off and on an issued invoice (counted in owedCents). */
  invoicedHandoffs: number;
  /** Delivered and accepted, not handed off yet (estimate). */
  deliveredCents: number;
  deliveredOrders: number;
  /** Tickets on those orders not accepted yet (not counted in deliveredCents). */
  ticketsPending: number;
  ticketsOpenCents: number | null;
  creditCents: number;
  /** Nothing owed, nothing waiting and no credit. */
  empty: boolean;
}

export function customerBalance(i: BalanceInput): BalanceSummary {
  const live = i.invoices.filter((x) => x.status === "issued");
  const owedCents = live.reduce((n, x) => n + balanceCents(x), 0);
  const overdueCents = live.filter((x) => invoiceState(x, i.today) === "overdue").reduce((n, x) => n + balanceCents(x), 0);
  const waiting = i.handoffs.filter((h) => h.invoice_status !== "issued");
  const handedOffCents = waiting.reduce((n, h) => n + Number(h.total_cents), 0);
  const delivered = i.delivered.filter((d) => d.value_cents > 0 || d.tickets_pending > 0);
  const deliveredCents = delivered.reduce((n, d) => n + Math.max(0, d.value_cents), 0);
  const ticketsPending = delivered.reduce((n, d) => n + d.tickets_pending, 0);
  return {
    owedCents,
    overdueCents,
    handedOffCents,
    handedOffCount: waiting.length,
    invoicedHandoffs: i.handoffs.length - waiting.length,
    deliveredCents,
    deliveredOrders: delivered.length,
    ticketsPending,
    ticketsOpenCents: i.ticketsOpenCents,
    creditCents: i.creditCents,
    empty: owedCents === 0 && waiting.length === 0 && delivered.length === 0 && !i.ticketsOpenCents && i.creditCents === 0,
  };
}
