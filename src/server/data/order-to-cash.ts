import "server-only";
import type { OrderRow } from "@/lib/order-to-cash";
import { createClient } from "@/server/supabase/server";

// Order-to-Cash Control Center (B42 increment 1): every open order's position, read from billing_order_status (the
// database's own readiness) plus confirmed orders still waiting for a date. Caller's company (RLS); read-only.

const COLUMNS = "order_id, order_number, status, customer_name, project_name, scheduled_start, order_date, completed_at, total_cents, loads_total, loads_missing, loads_not_due, tickets_live, tickets_pending, exceptions_count, readiness, fulfilled, fulfillment_gap, handed_off_at, changed_since_handoff, batch_number";
const n = (v: unknown) => Number(v ?? 0);

export async function orderToCashRows(): Promise<OrderRow[]> {
  const supabase = await createClient();
  const [billing, unscheduled] = await Promise.all([
    supabase.from("billing_order_status").select(COLUMNS).order("order_date", { ascending: false }).limit(3000),
    supabase.from("orders").select("id, order_number, status, project_name, order_date, total_cents, customers(name)").eq("status", "confirmed").is("scheduled_start", null).limit(500),
  ]);
  if (billing.error) throw new Error(`Order-to-cash could not be read: ${billing.error.message}`);
  if (unscheduled.error) throw new Error(`Order-to-cash could not be read: ${unscheduled.error.message}`);
  const rows = ((billing.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as OrderRow),
    total_cents: n(r.total_cents), loads_total: n(r.loads_total), loads_missing: n(r.loads_missing), loads_not_due: n(r.loads_not_due),
    tickets_live: n(r.tickets_live), tickets_pending: n(r.tickets_pending), exceptions_count: n(r.exceptions_count),
    changed_since_handoff: Boolean(r.changed_since_handoff), fulfilled: Boolean(r.fulfilled),
  }));
  const waiting = ((unscheduled.data ?? []) as unknown as Array<{ id: string; order_number: string; status: string; project_name: string | null; order_date: string; total_cents: number | string; customers: { name: string } | null }>).map<OrderRow>((o) => ({
    order_id: o.id, order_number: o.order_number, status: o.status, customer_name: o.customers?.name ?? null, project_name: o.project_name,
    scheduled_start: null, order_date: o.order_date, completed_at: null, total_cents: n(o.total_cents), loads_total: 0, loads_missing: 0, loads_not_due: 0,
    tickets_live: 0, tickets_pending: 0, exceptions_count: 0, readiness: "in_progress", fulfilled: false, fulfillment_gap: "no_loads",
    handed_off_at: null, changed_since_handoff: false, batch_number: null,
  }));
  return [...waiting, ...rows];
}
