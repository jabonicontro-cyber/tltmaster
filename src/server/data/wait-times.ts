import "server-only";
import { addDays } from "@/lib/dates";
import type { Stop, StopTime } from "@/lib/dispatch/wait-times";
import { createClient } from "@/server/supabase/server";

// Wait times (B111, migration 20261120005200), read through the person's session (dispatch.view, billing.view, or a
// driver's own loads). Returns null before the migration is installed.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202", "PGRST200"]);

type Row = {
  load_id: string; order_id: string; stop: Stop; arrived_at: string | null; departed_at: string | null; source: StopTime["source"]; location_id: string | null;
  orders: { order_number: string; site_id: string | null; site_label: string; site_line1: string; site_city: string; customers: { name: string } | null } | null;
  company_locations: { name: string } | null;
};

const SELECT = "load_id, order_id, stop, arrived_at, departed_at, source, location_id, orders(order_number, site_id, site_label, site_line1, site_city, customers(name)), company_locations(name)";

function toStop(r: Row): StopTime {
  const o = r.orders;
  const site = o ? (o.site_label || [o.site_line1, o.site_city].filter(Boolean).join(", ")) : "";
  return {
    loadId: r.load_id, orderId: r.order_id, orderNumber: o?.order_number ?? "", stop: r.stop, source: r.source,
    placeKey: r.stop === "site" ? (o?.site_id ?? (site || null)) : r.location_id,
    placeLabel: r.stop === "site" ? (site || null) : (r.company_locations?.name ?? null),
    customerName: o?.customers?.name ?? null, arrivedAt: r.arrived_at, departedAt: r.departed_at,
  };
}

export async function waitTimeSettings(): Promise<{ installed: boolean; freeMinutes: number | null }> {
  const { data, error } = await (await createClient()).from("wait_time_settings").select("free_minutes").maybeSingle();
  if (error) return { installed: !MISSING.has(error.code ?? ""), freeMinutes: null };
  return { installed: true, freeMinutes: (data as { free_minutes: number | null } | null)?.free_minutes ?? null };
}

/** Stops whose arrival falls on [from, to] in the company's time zone (ISO dates, inclusive), newest first. */
export async function listStopTimes(fromIso: string, toIso: string, timeZone: string): Promise<StopTime[] | null> {
  // Fetch a day either side in UTC, then keep the stops whose local arrival date is in range.
  const { data, error } = await (await createClient()).from("load_stop_times").select(SELECT)
    .gte("arrived_at", `${addDays(fromIso, -1)}T00:00:00Z`).lt("arrived_at", `${addDays(toIso, 2)}T00:00:00Z`).order("arrived_at", { ascending: false }).limit(5000);
  if (error) {
    if (MISSING.has(error.code ?? "")) return null;
    throw new Error(`Could not load wait times: ${error.message}`);
  }
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return ((data ?? []) as unknown as Row[]).map(toStop).filter((t) => {
    const d = t.arrivedAt ? localDate.format(new Date(t.arrivedAt)) : null;
    return d !== null && d >= fromIso && d <= toIso;
  });
}

/** The stops recorded for these loads (My Day). Empty when not installed. */
export async function stopTimesForLoads(loadIds: string[]): Promise<StopTime[]> {
  if (!loadIds.length) return [];
  const { data, error } = await (await createClient()).from("load_stop_times").select(SELECT).in("load_id", loadIds);
  if (error) return [];
  return ((data ?? []) as unknown as Row[]).map(toStop);
}
