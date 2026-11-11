import "server-only";
import { customerBalance, type BalanceSummary } from "@/lib/billing/balance";
import { buildInvoiceDraft, type DraftOrderLine, type DraftTicket } from "@/lib/billing/invoice-draft";
import type { InvoiceLite } from "@/lib/billing/invoices";
import { payableCents } from "@/lib/billing/ticket-payments";
import { allRows } from "@/server/data/all-rows";
import { createClient } from "@/server/supabase/server";
import { invoicesByHandoff, invoicingSettings, type Issuer } from "./invoices";
import { customerTicketBalances } from "./ticket-payments";

export type BalanceInvoiceRow = Pick<InvoiceLite, "status" | "total_cents" | "payments" | "due_date"> & { id: string; number: string | null; issue_date: string | null; sent_at: string | null };

export interface CustomerBalanceView {
  issuer: Issuer;
  summary: BalanceSummary;
  invoices: BalanceInvoiceRow[];
  /** Handed off and not on an issued invoice yet. */
  waiting: Array<{ order_id: string; order_number: string; total_cents: number; invoice: { id: string; number: string | null } | null }>;
  /** Delivered work still in billing review, with its value so far (estimate). */
  delivered: Array<{ order_id: string; order_number: string; value_cents: number; tickets_pending: number }>;
}

/**
 * Everything the customer page's Balance block shows, read through the person's session (billing.view, RLS). Each
 * source is optional: a missing update (invoicing, payments by ticket) leaves its figure out instead of failing.
 */
export async function getCustomerBalance(customerId: string, today: string): Promise<CustomerBalanceView> {
  const supabase = await createClient();
  const [inv, open, handoffs, settings] = await Promise.all([
    supabase.from("invoices")
      .select("id, number, status, total_cents, due_date, issue_date, sent_at, payments:invoice_payments(amount_cents, voided_at)")
      .eq("customer_id", customerId).neq("status", "draft").order("issue_date", { ascending: false }).limit(200),
    supabase.from("billing_order_status")
      .select("order_id, order_number, readiness, tickets_pending, tickets_accepted")
      .eq("customer_id", customerId).neq("readiness", "handed_off").order("order_number").limit(200),
    supabase.from("billing_handoff_orders")
      .select("id, order_id, number:snapshot->order->>order_number, total:snapshot->order->total_cents, orders!billing_handoff_orders_order_fk!inner(customer_id)")
      .is("reverted_at", null).eq("orders.customer_id", customerId).limit(500),
    invoicingSettings(),
  ]);

  const invoices = (inv.error ? [] : (inv.data ?? []) as unknown as BalanceInvoiceRow[])
    .map((r) => ({ ...r, total_cents: Number(r.total_cents), payments: (r.payments ?? []).map((p) => ({ ...p, amount_cents: Number(p.amount_cents) })) }));

  const handed = (handoffs.error ? [] : (handoffs.data ?? []) as unknown as Array<{ id: string; order_id: string; number: string | null; total: number | string | null }>);
  const byHandoff = await invoicesByHandoff(handed.map((h) => h.id));
  const waiting = handed
    .filter((h) => byHandoff[h.id]?.status !== "issued")
    .map((h) => ({ order_id: h.order_id, order_number: h.number ?? "Order", total_cents: Number(h.total ?? 0), invoice: byHandoff[h.id] ? { id: byHandoff[h.id].id, number: byHandoff[h.id].number } : null }));

  // Delivered so far on orders still in billing review: the invoice draft's figure (accepted tickets at the order's
  // approved prices), the same calculation the order's billing page shows.
  const inReview = (open.error ? [] : (open.data ?? []) as Array<{ order_id: string; order_number: string; tickets_pending: number; tickets_accepted: number }>)
    .filter((o) => o.tickets_accepted > 0 || o.tickets_pending > 0)
    .slice(0, 60);
  const priced = inReview.filter((o) => o.tickets_accepted > 0).map((o) => o.order_id);
  const [lines, tickets, orders] = priced.length
    ? await Promise.all([
        supabase.from("order_lines").select("id, order_id, line_no, kind, calc_method, description, unit_code, quantity, unit_rate_cents, percent_bp, taxable, amount_cents").in("order_id", priced),
        supabase.from("delivery_tickets").select("order_id, order_line_id, status, quantity, unit_code").in("order_id", priced).in("status", ["submitted", "needs_review", "accepted"]),
        supabase.from("orders").select("id, tax_rate_bp, total_cents").in("id", priced),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];
  const lineRows = (lines.data ?? []) as Array<DraftOrderLine & { order_id: string }>;
  const ticketRows = (tickets.data ?? []) as Array<DraftTicket & { order_id: string }>;
  const orderRows = new Map(((orders.data ?? []) as Array<{ id: string; tax_rate_bp: number; total_cents: number }>).map((o) => [o.id, o]));
  const delivered = inReview.map((o) => {
    const order = orderRows.get(o.order_id);
    const value = o.tickets_accepted > 0 && order
      ? buildInvoiceDraft({
          lines: lineRows.filter((l) => l.order_id === o.order_id),
          tickets: ticketRows.filter((t) => t.order_id === o.order_id),
          taxRateBp: order.tax_rate_bp ?? 0,
          orderTotalCents: Number(order.total_cents),
          readiness: null,
        }).totalCents
      : 0;
    return { order_id: o.order_id, order_number: o.order_number, value_cents: value, tickets_pending: o.tickets_pending };
  });

  // Payments by ticket (TP1): unapplied credit always; what is open on tickets only where QuickBooks issues the
  // invoices (with Taviron invoices the same money is already in the invoice balance).
  const tickets_ = await customerTicketBalances(customerId).catch(() => null);
  const ticketsOpenCents = tickets_ && settings.issuer === "quickbooks" ? tickets_.tickets.reduce((n, t) => n + payableCents(t), 0) : null;

  const summary = customerBalance({
    today,
    invoices,
    handoffs: handed.map((h) => ({ total_cents: Number(h.total ?? 0), invoice_status: byHandoff[h.id]?.status ?? null })),
    delivered,
    ticketsOpenCents,
    creditCents: tickets_?.unapplied_cents ?? 0,
  });
  return { issuer: settings.issuer, summary, invoices: invoices.filter((r) => r.status !== "void"), waiting, delivered: delivered.filter((d) => d.value_cents > 0 || d.tickets_pending > 0) };
}

/** What each listed customer owes on issued invoices (and how much is overdue), for the customer list. One query. */
export async function owedByCustomer(customerIds: string[], today: string): Promise<Map<string, { owed: number; overdue: number }> | null> {
  if (!customerIds.length) return new Map();
  const supabase = await createClient();
  const { data, error } = await allRows(() => supabase.from("invoices")
    .select("customer_id, status, total_cents, due_date, payments:invoice_payments(amount_cents, voided_at)")
    .in("customer_id", customerIds).eq("status", "issued").order("id"));
  if (error) return null;
  const out = new Map<string, { owed: number; overdue: number }>();
  for (const r of (data ?? []) as unknown as Array<{ customer_id: string; status: "issued"; total_cents: number; due_date: string | null; payments: Array<{ amount_cents: number; voided_at: string | null }> }>) {
    const row = { ...r, total_cents: Number(r.total_cents), payments: (r.payments ?? []).map((p) => ({ ...p, amount_cents: Number(p.amount_cents) })) };
    const s = customerBalance({ today, invoices: [row], handoffs: [], delivered: [], ticketsOpenCents: null, creditCents: 0 });
    const cur = out.get(r.customer_id) ?? { owed: 0, overdue: 0 };
    out.set(r.customer_id, { owed: cur.owed + s.owedCents, overdue: cur.overdue + s.overdueCents });
  }
  return out;
}
