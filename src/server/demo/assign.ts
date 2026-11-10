import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Demo assignments go through the same public.assign_load as dispatch. When a sample driver is scheduled off for a
// sample load (20261120003300), the demo uses the same off-shift path a dispatcher would, with a reason that says it
// is a demo sample, so the shift check is never bypassed and the assignment shows as made outside the shift.

export const DEMO_OFF_SHIFT_REASON = "Demo: extra shift for this sample load (fictional)";

// A sample load for the demo's customer on credit hold goes ahead the way a dispatcher's would: with a reason, which the
// database records (financial review L2, 20261120016300). Ignored for a customer not on hold.
export const DEMO_CREDIT_REASON = "Demo: sample load for a customer on credit hold (fictional)";

type Args = { p_load_id: string; p_truck_id: string | null | undefined; p_trailer_id: string | null | undefined; p_driver_id: string | null | undefined; p_note?: string; p_replace_assignment_id?: string | null };

export async function demoAssign(db: SupabaseClient, args: Args): Promise<{ data: unknown; error: { message: string; code?: string; hint?: string } | null }> {
  const first = await withCreditReason(db, "assign_load", args);
  if (first.error?.hint !== "off_shift") return first;
  return withCreditReason(db, "assign_load_off_shift", { ...args, p_note: args.p_note ?? "", p_replace_assignment_id: args.p_replace_assignment_id ?? null, p_reason: DEMO_OFF_SHIFT_REASON });
}

/** Confirms a sample hired-truck offer (B83) with the demo's credit-hold reason, as demoAssign. */
export async function demoConfirmOffer(db: SupabaseClient, offerId: unknown): Promise<{ data: unknown; error: { message: string; code?: string; hint?: string } | null }> {
  return withCreditReason(db, "hauler_offer_confirm", { p_offer: offerId });
}

/** With the credit-hold reason; before 20261120016300 (no such argument, PGRST202) without it, as before. */
async function withCreditReason(db: SupabaseClient, fn: "assign_load" | "assign_load_off_shift" | "hauler_offer_confirm", args: Record<string, unknown>) {
  const key = fn === "hauler_offer_confirm" ? "p_reason" : "p_credit_reason";
  const r = await db.rpc(fn, { ...args, [key]: DEMO_CREDIT_REASON });
  return r.error?.code === "PGRST202" ? db.rpc(fn, args) : r;
}
