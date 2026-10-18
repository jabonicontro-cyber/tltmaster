import "server-only";
import { addDays } from "@/lib/dates";
import { buildOutlook, type OutlookDay, type OutlookLoad, type OutlookShopVisit, type OutlookTimeOff, type OutlookTruck } from "@/lib/live/outlook";
import { estimateLoadRevenueCents, type RateLine } from "@/lib/orders/load-revenue";
import { createClient } from "@/server/supabase/server";
import { DISPATCHABLE } from "./smart-dispatch";

export const OUTLOOK_DAYS = 7;

export interface Outlook {
  days: OutlookDay[];
  /** Whether shop dates and time off were read (false = that database update is not installed yet). */
  shopChecked: boolean;
  timeOffChecked: boolean;
  /** Whether revenue estimates were read (only for people who may see figures). */
  valueShown: boolean;
}

/**
 * Taviron Live: the next `OUTLOOK_DAYS` days for the caller's company (RLS), from the same records dispatch uses.
 * Bounded reads: planned loads in the window with their active assignment, active trucks, active driver count, the
 * shop schedule and time off for the window, and — with `withValue` — the rates of orders whose loads have no truck.
 */
export async function loadOutlook(today: string, withValue: boolean): Promise<Outlook> {
  const supabase = await createClient();
  const to = addDays(today, OUTLOOK_DAYS - 1);
  const [loads, trucks, drivers, shop, leave] = await Promise.all([
    supabase
      .from("order_loads")
      .select("id, order_id, load_date, planned_quantity, unit_code, orders!inner(status), dispatch_assignments(truck_id, status)")
      .eq("status", "planned")
      .gte("load_date", today)
      .lte("load_date", to)
      .in("orders.status", DISPATCHABLE)
      .limit(5000),
    supabase.from("trucks").select("id, service_status, expected_return_date").eq("active", true),
    supabase.from("driver_list").select("id", { count: "exact", head: true }).eq("active", true),
    supabase.rpc("dispatch_shop_schedule", { p_from: today, p_to: to }),
    supabase.rpc("dispatch_time_off", { p_from: today, p_to: to }),
  ]);
  if (loads.error || trucks.error || drivers.error) throw new Error("The outlook could not be read.");
  const missing = (e: { code?: string } | null) => Boolean(e && (e.code === "PGRST202" || e.code === "42883"));
  if (shop.error && !missing(shop.error)) throw new Error("The shop schedule could not be read.");
  if (leave.error && !missing(leave.error)) throw new Error("Time off could not be read.");

  type Row = { id: string; order_id: string; load_date: string; planned_quantity: number | string | null; unit_code: string | null; dispatch_assignments: Array<{ truck_id: string | null; status: string }> };
  const rows = (loads.data ?? []) as unknown as Row[];
  const truckOf = (r: Row) => r.dispatch_assignments.find((a) => a.status === "active")?.truck_id ?? null;

  let lines: RateLine[] = [];
  const open = rows.filter((r) => !truckOf(r));
  if (withValue && open.length) {
    const ids = [...new Set(open.map((r) => r.order_id))];
    const res = await supabase.from("order_lines").select("order_id, kind, calc_method, unit_code, unit_rate_cents").in("order_id", ids);
    if (res.error) throw new Error("Order rates could not be read.");
    lines = (res.data ?? []) as RateLine[];
  }
  const outlookLoads: OutlookLoad[] = rows.map((r) => {
    const truck = truckOf(r);
    const qty = r.planned_quantity === null ? null : Number(r.planned_quantity);
    return { id: r.id, load_date: r.load_date, truck_id: truck, revenue_cents: !truck && withValue ? estimateLoadRevenueCents(lines, { order_id: r.order_id, unit_code: r.unit_code, planned_quantity: qty }) : null };
  });
  const timeOff: OutlookTimeOff[] = missing(leave.error)
    ? []
    : ((leave.data ?? []) as Array<{ driver_id: string; status: "approved" | "pending"; start_date: string; end_date: string; full_day: boolean }>).map((t) => ({
        driver_id: t.driver_id, status: t.status, first_day: t.start_date, last_day: t.end_date, full_day: t.full_day,
      }));
  const days = Array.from({ length: OUTLOOK_DAYS }, (_, i) => addDays(today, i));
  return {
    days: buildOutlook({
      days,
      loads: outlookLoads,
      trucks: (trucks.data ?? []) as OutlookTruck[],
      shop: missing(shop.error) ? [] : ((shop.data ?? []) as OutlookShopVisit[]),
      drivers: drivers.count ?? 0,
      timeOff,
    }),
    shopChecked: !missing(shop.error),
    timeOffChecked: !missing(leave.error),
    valueShown: withValue,
  };
}
