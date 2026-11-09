import "server-only";
import { createClient } from "@/server/supabase/server";

// Credit holds (B128; owner 2026-11-02: warn, and a reason to proceed). Read with the person's own session; amounts come
// back only for people who may see billing. Before the migration is applied every customer reads as not on hold.

import { holdSummary, type HoldReason } from "@/lib/credit";

export { holdSummary, type HoldReason };

export interface CreditHold {
  customerId: string;
  name: string;
  reasons: HoldReason[];
  note: string;
  openCents: number | null;
  creditLimitCents: number | null;
  oldestOverdueDays: number | null;
}


export async function creditHolds(customerIds?: string[]): Promise<Map<string, CreditHold>> {
  if (customerIds && customerIds.length === 0) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("customer_credit_holds", { p_customers: customerIds ?? null });
  if (error) return new Map();
  const rows = (data ?? []) as Array<{ customer_id: string; name: string; reasons: HoldReason[]; note: string; open_cents: number | null; credit_limit_cents: number | null; oldest_overdue_days: number | null }>;
  return new Map(rows.map((r) => [r.customer_id, {
    customerId: r.customer_id, name: r.name, reasons: r.reasons, note: r.note ?? "",
    openCents: r.open_cents === null ? null : Number(r.open_cents), creditLimitCents: r.credit_limit_cents === null ? null : Number(r.credit_limit_cents), oldestOverdueDays: r.oldest_overdue_days,
  }]));
}

/**
 * The gate for creating an order or dispatching a load: null when the customer is not on hold or a reason was given
 * (the caller then records it with recordCreditOverride after the work is saved); otherwise the message to show.
 */
export async function creditGate(customerId: string, reason: string | undefined): Promise<{ hold: CreditHold; message: string } | null> {
  const hold = (await creditHolds([customerId])).get(customerId);
  if (!hold) return null;
  if (reason && reason.trim().length >= 3) return null;
  return { hold, message: `${hold.name} is ${holdSummary(hold).replace(/\.+$/, "")}. To go ahead, give a reason; it is recorded.` };
}

/** Records why someone went ahead; false when it could not be recorded (the caller says so). */
export async function recordCreditOverride(customerId: string, context: "order" | "assignment", entityId: string | null, reason: string | undefined): Promise<boolean> {
  if (!reason?.trim()) return true;
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_credit_override", { p_customer: customerId, p_context: context, p_entity: entityId, p_reason: reason.trim() });
  if (error) console.warn("Credit override not recorded", { code: error.code });
  return !error;
}

/** The customer of an order (null when it cannot be read). */
export async function orderCustomer(orderId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("orders").select("customer_id").eq("id", orderId).maybeSingle();
  return (data as { customer_id: string } | null)?.customer_id ?? null;
}
