import { addDays } from "@/lib/dates";
import type { DayRestrictions } from "@/lib/dispatch/board";
import type { SmartShift } from "@/lib/dispatch/smart";
import { formatTime } from "@/lib/orders/schedule";
import { createClient } from "@/server/supabase/server";

/**
 * The board's day restrictions (B1): open work orders, unresolved driver reports, expired vehicle documents, time off
 * and shifts for one date, read with the person's session through the same functions Smart Dispatch uses. Each read
 * that fails (or is not installed yet) leaves its list empty: the board then shows less, and assign_load still checks
 * every rule. Nothing here decides anything.
 */
export async function loadDayRestrictions(date: string): Promise<DayRestrictions> {
  const supabase = await createClient();
  const settle = <T,>(p: PromiseLike<{ data: unknown; error: unknown }>, map: (data: unknown) => T, empty: T): Promise<T> =>
    Promise.resolve(p).then((r) => (r.error ? empty : map(r.data)), () => empty);
  const [shop, reports, documents, timeOff, shifts] = await Promise.all([
    settle(supabase.rpc("dispatch_shop_schedule", { p_from: date, p_to: date }), (d) => (d ?? []) as DayRestrictions["shop"], []),
    settle(
      supabase.from("field_reports").select("equipment, truck_id, trailer_id, kind").in("status", ["open", "acknowledged"]),
      (d) => (d ?? []) as DayRestrictions["reports"],
      [],
    ),
    settle(supabase.rpc("dispatch_document_issues", { p_on: date }), (d) => ((d ?? []) as DayRestrictions["documents"]).map((x) => ({ truck_id: x.truck_id, trailer_id: x.trailer_id, blocks: Boolean(x.blocks) })), []),
    settle(supabase.rpc("dispatch_time_off", { p_from: date, p_to: date }), (d) => (d ?? []) as DayRestrictions["timeOff"], []),
    // From the day before (overnight shifts), as Smart Dispatch reads them.
    settle(
      supabase.rpc("schedule_range", { p_from: addDays(date, -1), p_days: 2 }),
      (d) =>
        ((d ?? []) as Array<{ driver_id: string | null; work_date: string; status: SmartShift["status"]; start_at: string | null; end_at: string | null; start_time: string | null; end_time: string | null }>)
          .filter((r) => r.driver_id)
          .map<SmartShift>((r) => ({ driver_id: r.driver_id!, date: r.work_date, status: r.status, start_at: r.start_at, end_at: r.end_at, label: r.start_time && r.end_time ? `${formatTime(r.start_time)}–${formatTime(r.end_time)}` : "" })),
      [],
    ),
  ]);
  return { shop, reports, documents, timeOff, shifts };
}
