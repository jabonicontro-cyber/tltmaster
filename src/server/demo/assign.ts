import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Demo assignments go through the same public.assign_load as dispatch. When a sample driver is scheduled off for a
// sample load (20261120003300), the demo uses the same off-shift path a dispatcher would, with a reason that says it
// is a demo sample, so the shift check is never bypassed and the assignment shows as made outside the shift.

export const DEMO_OFF_SHIFT_REASON = "Demo: extra shift for this sample load (fictional)";

type Args = { p_load_id: string; p_truck_id: string | null | undefined; p_trailer_id: string | null | undefined; p_driver_id: string | null | undefined; p_note?: string; p_replace_assignment_id?: string | null };

export async function demoAssign(db: SupabaseClient, args: Args): Promise<{ data: unknown; error: { message: string; code?: string; hint?: string } | null }> {
  const first = await db.rpc("assign_load", args);
  if (first.error?.hint !== "off_shift") return first;
  return db.rpc("assign_load_off_shift", { ...args, p_note: args.p_note ?? "", p_replace_assignment_id: args.p_replace_assignment_id ?? null, p_reason: DEMO_OFF_SHIFT_REASON });
}
