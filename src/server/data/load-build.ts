import "server-only";
import { z } from "zod";
import { BUILD_UNITS, buildLoads, datesBetween, payloadOptions, type BuildResult, type BuildTruck, type BuildUnit } from "@/lib/dispatch/load-build";
import { createClient } from "@/server/supabase/server";
import { businessToday } from "@/server/data/settings";

/** Order statuses that accept planned loads (mirrors private.order_is_dispatchable). */
const DISPATCHABLE = ["scheduled", "dispatched", "in_progress", "partially_completed"];

export interface LoadBuildContext {
  order: { id: string; order_number: string; status: string; customer_name: string; scheduled_start: string | null; scheduled_end: string | null; window_start: string | null; window_end: string | null };
  /** Why a load build cannot be offered for this order at all (before any parameters). */
  unavailable: string | null;
  unit: BuildUnit | null;
  material: string | null;
  orderedQty: number;
  plannedQty: number;
  loadsWithoutQuantity: number;
  days: string[];
  trucks: BuildTruck[];
  payloads: number[];
}

export const buildParams = z.object({
  payload: z.coerce.number().positive().max(999999.999).optional(),
  perDay: z.coerce.number().int().min(1).max(200).optional(),
  mode: z.enum(["even", "earliest"]).default("even"),
});
export type BuildParams = z.infer<typeof buildParams>;

/**
 * Everything a load build needs for one order, read with the caller's own
 * session: row-level security limits the order, its lines, its loads and the
 * trucks to the caller's company, so another company's records are never seen.
 * Returns null when the order does not exist for this caller.
 */
export async function getLoadBuildContext(orderId: string): Promise<LoadBuildContext | null> {
  if (!z.uuid().safeParse(orderId).success) return null;
  const supabase = await createClient();
  const { data: o, error } = await supabase
    .from("orders")
    .select("id, order_number, status, scheduled_start, scheduled_end, window_start, window_end, customers(name)")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the order: ${error.message}`);
  if (!o) return null;
  const { today } = await businessToday();
  const [lines, loads, trucks, reports] = await Promise.all([
    supabase.from("order_lines").select("material_id, description, quantity, unit_code, kind").eq("order_id", orderId),
    supabase.from("order_loads").select("planned_quantity, unit_code").eq("order_id", orderId).eq("status", "planned"),
    supabase.from("trucks").select("id, unit_number, active, service_status, weight_capacity, weight_unit, volume_capacity, capacity_verified_at").eq("active", true),
    supabase.from("field_reports").select("truck_id, kind").eq("equipment", "truck").in("status", ["open", "acknowledged"]),
  ]);
  for (const r of [lines, loads, trucks, reports]) {
    // Never plan from partial data (for example without fleet access).
    if (r.error) throw new Error(`Load build could not read the data it needs: ${r.error.message}`);
  }

  const order = {
    id: o.id as string,
    order_number: o.order_number as string,
    status: o.status as string,
    customer_name: ((o.customers as unknown as { name: string } | null)?.name) ?? "",
    scheduled_start: o.scheduled_start as string | null,
    scheduled_end: o.scheduled_end as string | null,
    window_start: o.window_start as string | null,
    window_end: o.window_end as string | null,
  };
  // A material line, or a hauling line (haul-only work and freight priced per load), in a buildable unit.
  const materialLines = (lines.data ?? []).filter((l) => (l.material_id || l.kind === "hauling") && l.quantity !== null && BUILD_UNITS.includes(l.unit_code as BuildUnit));
  let unavailable: string | null = null;
  if (!DISPATCHABLE.includes(order.status)) unavailable = `The order is ${order.status.replace(/_/g, " ")}. Loads can be built once it is scheduled.`;
  else if (!order.scheduled_start) unavailable = "The order has no scheduled dates yet.";
  else if (materialLines.length === 0) unavailable = "The order has no material or hauling line in tons, cubic yards or loads, so there is no quantity to split into loads.";
  else if (materialLines.length > 1) unavailable = "The order has more than one material or hauling line. Building loads per line is not supported yet; plan these loads on the dispatch board.";

  const line = materialLines.length === 1 ? materialLines[0] : null;
  const unit = (line?.unit_code as BuildUnit | undefined) ?? null;
  const loadRows = loads.data ?? [];
  const plannedQty = loadRows.filter((l) => l.unit_code === unit && l.planned_quantity !== null).reduce((a, l) => a + Number(l.planned_quantity), 0);
  const safety = new Set((reports.data ?? []).filter((r) => r.kind === "breakdown" || r.kind === "inspection_issue").map((r) => r.truck_id as string));
  const truckRows: BuildTruck[] = (trucks.data ?? []).map((t) => ({
    id: t.id as string,
    unit_number: t.unit_number as string,
    active: Boolean(t.active),
    service_status: t.service_status as BuildTruck["service_status"],
    weight_capacity: t.weight_capacity === null ? null : Number(t.weight_capacity),
    weight_unit: t.weight_unit as BuildTruck["weight_unit"],
    volume_capacity: t.volume_capacity === null ? null : Number(t.volume_capacity),
    capacity_verified_at: t.capacity_verified_at as string | null,
    safety_report: safety.has(t.id as string),
  }));
  const from = order.scheduled_start && order.scheduled_start > today ? order.scheduled_start : today;
  const to = order.scheduled_end ?? order.scheduled_start;
  return {
    order,
    unavailable,
    unit,
    material: line?.description ?? null,
    orderedQty: line ? Number(line.quantity) : 0,
    plannedQty,
    loadsWithoutQuantity: loadRows.filter((l) => l.planned_quantity === null).length,
    days: to && from <= to ? datesBetween(from, to) : [],
    trucks: truckRows,
    payloads: unit ? payloadOptions(truckRows, unit) : [],
  };
}

/** The draft for these parameters, computed on the server from the context (never from client figures). */
export function draftFor(ctx: LoadBuildContext, p: BuildParams): BuildResult | null {
  if (ctx.unavailable || !ctx.unit || p.payload === undefined || p.perDay === undefined) return null;
  return buildLoads({ unit: ctx.unit, orderedQty: ctx.orderedQty, plannedQty: ctx.plannedQty, payload: p.payload, loadsPerDay: p.perDay, mode: p.mode, days: ctx.days, trucks: ctx.trucks });
}
