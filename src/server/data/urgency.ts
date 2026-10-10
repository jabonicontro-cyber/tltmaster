import "server-only";
import type { UrgencyState } from "@/lib/orders/urgency";
import { uuid } from "@/lib/schemas/common";
import { createClient } from "@/server/supabase/server";

export interface UrgencyRow {
  id: string;
  order_id: string;
  reason: string;
  needed_by: string | null;
  state: UrgencyState;
  state_note: string;
  flagged_by: string | null;
  flagged_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  state_changed_by: string | null;
  state_changed_at: string;
  closed_at: string | null;
}

export interface UrgencyEventRow {
  id: string;
  urgency_id: string;
  action: "flagged" | "updated" | "state_changed" | "closed_with_order";
  from_state: UrgencyState | null;
  to_state: UrgencyState;
  note: string;
  details: { needed_by?: string | null };
  actor_id: string | null;
  occurred_at: string;
}

/** The order's open urgent flag (if any) and the history of all its flags, as RLS allows (orders.view or dispatch.view). */
export async function getOrderUrgency(orderId: string): Promise<{ open: UrgencyRow | null; events: UrgencyEventRow[] } | null> {
  if (!uuid.safeParse(orderId).success) return null;
  const supabase = await createClient();
  const [flags, events] = await Promise.all([
    supabase.from("order_urgencies").select("*").eq("order_id", orderId).order("flagged_at", { ascending: false }).limit(20),
    supabase.from("order_urgency_events").select("*").eq("order_id", orderId).order("occurred_at", { ascending: false }).limit(50),
  ]);
  if (flags.error || events.error) return null;
  const rows = (flags.data ?? []) as UrgencyRow[];
  return { open: rows.find((r) => !r.closed_at) ?? null, events: (events.data ?? []) as UrgencyEventRow[] };
}

export interface OpenUrgency extends UrgencyRow {
  orders: { order_number: string; status: string; scheduled_start: string | null; customers: { name: string } | null } | null;
}

/** Every open urgent flag in the current company, oldest first (dispatch board banner). */
export async function listOpenUrgencies(): Promise<OpenUrgency[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("order_urgencies")
    .select("*, orders!order_urgencies_order_fk(order_number, status, scheduled_start, customers!orders_customer_fk(name))")
    .is("closed_at", null)
    .order("flagged_at")
    .limit(50);
  if (error) return null;
  return (data ?? []) as unknown as OpenUrgency[];
}
