import "server-only";
import { explainLoad, unavailableResources } from "@/lib/optimization/availability";
import { optimizeWithAlternatives, type OptimizationInput, type Priorities } from "@/lib/optimization/plan";
import { createClient } from "@/server/supabase/server";
import { estimateLoadRevenueCents } from "@/lib/orders/load-revenue";
import { DISPATCHABLE, getSmartDispatchInput } from "./smart-dispatch";
import { getTrailerInput } from "./trailer-input";

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
    for (const l of smart.loads) revenueCents[l.id] = estimateLoadRevenueCents(lines, l);
  }
  // Trailers for tractors (shared with Smart Dispatch) and vehicle documents.
  const supabase = await createClient();
  const [trailerInput, documents] = await Promise.all([
    getTrailerInput(date, date),
    supabase.from("vehicle_documents").select("truck_id, trailer_id, kind, expires_on").is("archived_at", null).in("kind", ["registration", "insurance", "inspection", "permit"]).not("expires_on", "is", null),
  ]);
  // The latest document of each kind per vehicle decides; an expired one that was renewed is not flagged.
  const latest = new Map<string, { truck_id: string | null; trailer_id: string | null; kind: string; expires_on: string }>();
  for (const d of (documents.data ?? []) as Array<{ truck_id: string | null; trailer_id: string | null; kind: string; expires_on: string }>) {
    const k = `${d.truck_id ?? d.trailer_id}|${d.kind}`;
    if (!latest.has(k) || latest.get(k)!.expires_on < d.expires_on) latest.set(k, d);
  }
  const expiredDocuments = [...latest.values()].filter((d) => d.expires_on < date);
  return {
    ...smart,
    revenueCents,
    hoursOfServiceVerified: false,
    // The company's document rules (20261112000200) when installed: every expired document, with whether it blocks.
    // Before that, the latest documents read directly (fleet.view) give review notes only.
    expiredDocuments: smart.documentIssues ?? (documents.error ? [] : expiredDocuments),
    documentsChecked: smart.documentIssues !== undefined || !documents.error,
    ...trailerInput,
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
