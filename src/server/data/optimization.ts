import "server-only";
import { addDays } from "@/lib/dates";
import { explainLoad, unavailableResources } from "@/lib/optimization/availability";
import { optimizeWithAlternatives, type OptimizationInput, type OptTrailer, type Priorities } from "@/lib/optimization/plan";
import { createClient } from "@/server/supabase/server";
import { DISPATCHABLE, getSmartDispatchInput } from "./smart-dispatch";

/**
 * Everything the optimization core reads for one day, from the caller's own company (RLS): the Smart Dispatch input
 * (loads, fleet, drivers, bookings, maintenance, time off) plus a revenue estimate per load from its order's own
 * material and hauling line rates in the load's unit × its planned quantity. No rate, no estimate (null) — never guessed.
 */
export async function getOptimizationInput(date: string): Promise<OptimizationInput> {
  const smart = await getSmartDispatchInput(date, date);
  const orderIds = [...new Set(smart.loads.map((l) => l.order_id))];
  const revenueCents: Record<string, number | null> = {};
  if (orderIds.length) {
    const db = await createClient();
    const { data, error } = await db
      .from("order_lines")
      .select("order_id, kind, calc_method, unit_code, unit_rate_cents, line_no")
      .in("order_id", orderIds)
      .order("line_no");
    if (error) throw new Error(`The optimizer could not read order rates: ${error.message}`);
    const lines = (data ?? []) as Array<{ order_id: string; kind: string; calc_method: string; unit_code: string | null; unit_rate_cents: number | string | null }>;
    for (const l of smart.loads) {
      // Material and hauling lines priced per the load's unit (aggregate: per ton; freight: per load). Both are revenue
      // for the load, so they add up; surcharges and lines in other units are not estimated per load.
      const priced = lines.filter((x) => x.order_id === l.order_id && (x.kind === "material" || x.kind === "hauling") && x.calc_method === "per_unit" && x.unit_code === l.unit_code && x.unit_rate_cents !== null);
      revenueCents[l.id] = priced.length && l.planned_quantity !== null ? Math.round(priced.reduce((sum, x) => sum + Number(x.unit_rate_cents), 0) * l.planned_quantity) : null;
    }
  }
  // Trailers for tractors: active trailers, their bookings around the day, and unresolved trailer reports.
  const supabase = await createClient();
  const dayStart = `${addDays(date, -1)}T00:00:00Z`;
  const dayEnd = `${addDays(date, 2)}T00:00:00Z`;
  const [trailers, booked, reports, documents] = await Promise.all([
    supabase.from("trailers").select("id, unit_number, active, service_status, weight_capacity, weight_unit, volume_capacity, capacity_verified_at, compatible_truck_types").eq("active", true),
    supabase.from("dispatch_assignments").select("trailer_id, load_id, starts_at, ends_at").eq("status", "active").not("trailer_id", "is", null).lt("starts_at", dayEnd).gt("ends_at", dayStart),
    supabase.from("field_reports").select("trailer_id, kind").eq("equipment", "trailer").in("status", ["open", "acknowledged"]),
    supabase.from("vehicle_documents").select("truck_id, trailer_id, kind, expires_on").is("archived_at", null).in("kind", ["registration", "insurance", "inspection", "permit"]).not("expires_on", "is", null),
  ]);
  // The latest document of each kind per vehicle decides; an expired one that was renewed is not flagged.
  const latest = new Map<string, { truck_id: string | null; trailer_id: string | null; kind: string; expires_on: string }>();
  for (const d of (documents.data ?? []) as Array<{ truck_id: string | null; trailer_id: string | null; kind: string; expires_on: string }>) {
    const k = `${d.truck_id ?? d.trailer_id}|${d.kind}`;
    if (!latest.has(k) || latest.get(k)!.expires_on < d.expires_on) latest.set(k, d);
  }
  const expiredDocuments = [...latest.values()].filter((d) => d.expires_on < date);
  for (const r of [trailers, booked, reports]) if (r.error) throw new Error(`The optimizer could not read trailers: ${r.error.message}`);
  return {
    ...smart,
    revenueCents,
    hoursOfServiceVerified: false,
    expiredDocuments: documents.error ? [] : expiredDocuments,
    documentsChecked: !documents.error,
    trailers: ((trailers.data ?? []) as Array<OptTrailer & { weight_capacity: number | string | null; volume_capacity: number | string | null; compatible_truck_types: string[] | null }>).map((t) => ({
      ...t,
      weight_capacity: t.weight_capacity === null ? null : Number(t.weight_capacity),
      volume_capacity: t.volume_capacity === null ? null : Number(t.volume_capacity),
      compatible_truck_types: t.compatible_truck_types ?? [],
    })),
    trailerBookings: (booked.data ?? []) as OptimizationInput["trailerBookings"],
    trailerReports: ((reports.data ?? []) as Array<{ trailer_id: string | null; kind: string }>).filter((r) => r.trailer_id).map((r) => ({ trailer_id: r.trailer_id as string, kind: r.kind })),
  };
}

export async function getOptimizationPlan(date: string, priorities: Priorities, preset: string | null) {
  const input = await getOptimizationInput(date);
  const result = optimizeWithAlternatives(input, priorities, preset);
  return {
    input,
    result,
    // Why the loads with no feasible truck, trailer and driver are blocked, and what cannot work at all that day.
    explanations: result.blocked.map((b) => explainLoad(input, b.loadId)),
    unavailable: unavailableResources(input),
  };
}

/**
 * Days from `from` through `to` with loads still waiting for a truck and driver (planned, not assigned, on an order
 * that can be dispatched), for the empty state of Plan the day. Caller's own company (RLS).
 */
export async function getUpcomingOpenLoadDays(from: string, to: string): Promise<Array<{ date: string; open: number }>> {
  const db = await createClient();
  const { data, error } = await db
    .from("order_loads")
    .select("id, load_date, orders(status)")
    .eq("status", "planned")
    .gte("load_date", from)
    .lte("load_date", to);
  if (error) throw new Error(`Upcoming loads could not be read: ${error.message}`);
  const rows = ((data ?? []) as unknown as Array<{ id: string; load_date: string; orders: { status: string } | null }>).filter((r) => r.orders && DISPATCHABLE.includes(r.orders.status));
  if (!rows.length) return [];
  const { data: assigned, error: aErr } = await db.from("dispatch_assignments").select("load_id").eq("status", "active").in("load_id", rows.map((r) => r.id));
  if (aErr) throw new Error(`Upcoming loads could not be read: ${aErr.message}`);
  const taken = new Set((assigned ?? []).map((a) => a.load_id as string));
  const days = new Map<string, number>();
  for (const r of rows) if (!taken.has(r.id)) days.set(r.load_date, (days.get(r.load_date) ?? 0) + 1);
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, open]) => ({ date, open }));
}
