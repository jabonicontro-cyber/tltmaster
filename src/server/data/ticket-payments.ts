import "server-only";
import type { TicketBalances } from "@/lib/billing/ticket-payments";
import { createClient } from "@/server/supabase/server";

// Payments by delivery ticket (TP1, migration 20261120009400), read through the person's session (billing.view, RLS).
// Before the migration is installed the loaders say so instead of failing the page.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export interface TicketCustomer { id: string; name: string }

/** Customers with billed (handed-off, not reverted) orders or recorded payments, by name. Null before the migration. */
export async function ticketPaymentCustomers(): Promise<TicketCustomer[] | null> {
  const supabase = await createClient();
  const [handoffs, payments] = await Promise.all([
    supabase.from("billing_handoff_orders").select("order:orders!billing_handoff_orders_order_fk(customer_id)").is("reverted_at", null).limit(5000),
    supabase.from("customer_payments").select("customer_id").limit(5000),
  ]);
  if (payments.error && MISSING.has(payments.error.code ?? "")) return null;
  const ids = new Set<string>();
  for (const h of (handoffs.data ?? []) as unknown as Array<{ order: { customer_id: string | null } | null }>) if (h.order?.customer_id) ids.add(h.order.customer_id);
  for (const p of (payments.data ?? []) as Array<{ customer_id: string }>) ids.add(p.customer_id);
  if (ids.size === 0) return [];
  const { data } = await supabase.from("customers").select("id, name").in("id", [...ids]).order("name");
  return (data ?? []) as TicketCustomer[];
}

/** One customer's billed tickets, payments and unapplied credit. Null when the customer is not found or not allowed. */
export async function customerTicketBalances(customerId: string): Promise<TicketBalances | null> {
  const { data, error } = await (await createClient()).rpc("customer_ticket_balances", { p_customer: customerId });
  if (error) return null;
  const b = data as TicketBalances;
  const num = (v: unknown) => Number(v ?? 0);
  return {
    issuer: b.issuer,
    unapplied_cents: num(b.unapplied_cents),
    tickets: (b.tickets ?? []).map((t) => ({ ...t, billed_cents: num(t.billed_cents), applied_cents: num(t.applied_cents), open_cents: num(t.open_cents), invoice_open_cents: t.invoice_open_cents === null || t.invoice_open_cents === undefined ? null : num(t.invoice_open_cents), qbo_numbers: t.qbo_numbers ?? [] })),
    payments: (b.payments ?? []).map((p) => ({ ...p, amount_cents: num(p.amount_cents), unapplied_cents: num(p.unapplied_cents), tickets: (p.tickets ?? []).map((a) => ({ ...a, amount_cents: num(a.amount_cents) })) })),
  };
}
