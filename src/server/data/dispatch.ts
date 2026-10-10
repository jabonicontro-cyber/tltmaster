import "server-only";
import { createClient } from "@/server/supabase/server";
import { businessToday } from "./settings";
import type { DriverListRow, OrderListRow, QualificationRow, TrailerRow, TruckRow, UnitRow } from "./types";

export type LoadStatus = "planned" | "canceled";
export type AssignmentStatus = "active" | "canceled";

export interface OrderLoadRow {
  id: string;
  order_id: string;
  load_number: number;
  load_date: string;
  /** "HH:MM:SS" local business time */
  start_time: string;
  end_time: string;
  starts_at: string;
  ends_at: string;
  planned_quantity: number | string | null;
  unit_code: string | null;
  notes: string;
  status: LoadStatus;
  cancel_reason: string;
  canceled_at: string | null;
  created_at: string;
}

export interface AssignmentRow {
  id: string;
  load_id: string;
  order_id: string;
  truck_id: string;
  trailer_id: string | null;
  driver_id: string;
  starts_at: string;
  ends_at: string;
  status: AssignmentStatus;
  note: string;
  warnings: string[];
  replaces_assignment_id: string | null;
  cancel_reason: string;
  canceled_at: string | null;
  canceled_by: string | null;
  created_by: string | null;
  created_at: string;
}

export type BoardTruck = Pick<TruckRow, "id" | "unit_number" | "truck_type" | "active" | "service_status" | "out_of_service_reason" | "weight_capacity" | "weight_unit" | "volume_capacity" | "volume_unit" | "capacity_verified_at">;
export type BoardTrailer = Pick<TrailerRow, "id" | "unit_number" | "trailer_type" | "active" | "service_status" | "out_of_service_reason" | "compatible_truck_types" | "weight_capacity" | "weight_unit" | "volume_capacity" | "volume_unit" | "capacity_verified_at">;
export type BoardDriver = Pick<DriverListRow, "id" | "display_name" | "active"> & { qualifications: Array<Pick<QualificationRow, "kind" | "cdl_class" | "expires_on" | "verified_at">> };

/** Orders whose scheduled dates cover `date`, their loads that day, assignments and the fleet. */
export async function getDispatchDay(date: string) {
  const supabase = await createClient();
  const [orders, loads, trucks, trailers, drivers, quals, units, { timezone, today }] = await Promise.all([
    supabase
      .from("order_list")
      .select("*")
      .lte("scheduled_start", date)
      .or(`scheduled_end.gte.${date},and(scheduled_end.is.null,scheduled_start.eq.${date})`)
      .not("status", "in", "(draft,canceled)")
      .order("window_start", { ascending: true, nullsFirst: false })
      .order("order_number"),
    supabase.from("order_loads").select("*").eq("load_date", date).order("start_time").order("load_number"),
    supabase.from("trucks").select("id, unit_number, truck_type, active, service_status, out_of_service_reason, weight_capacity, weight_unit, volume_capacity, volume_unit, capacity_verified_at").eq("active", true).order("unit_number"),
    supabase.from("trailers").select("id, unit_number, trailer_type, active, service_status, out_of_service_reason, compatible_truck_types, weight_capacity, weight_unit, volume_capacity, volume_unit, capacity_verified_at").eq("active", true).order("unit_number"),
    supabase.from("driver_list").select("id, display_name, active").eq("active", true).order("display_name"),
    supabase.from("driver_qualifications").select("driver_id, kind, cdl_class, expires_on, verified_at"),
    supabase.from("units_of_measure").select("*").order("sort_order"),
    businessToday(),
  ]);
  for (const r of [orders, loads, trucks, trailers, drivers, quals, units]) {
    if (r.error) throw new Error(`Could not load the dispatch board: ${r.error.message}`);
  }
  const loadRows = (loads.data ?? []) as OrderLoadRow[];
  let orderRows = (orders.data ?? []) as OrderListRow[];

  // Loads whose order's schedule was changed after planning still show (flagged on the board).
  const missing = [...new Set(loadRows.map((l) => l.order_id))].filter((id) => !orderRows.some((o) => o.id === id));
  if (missing.length) {
    const extra = await supabase.from("order_list").select("*").in("id", missing);
    orderRows = [...orderRows, ...((extra.data ?? []) as OrderListRow[])];
  }

  const loadIds = loadRows.map((l) => l.id);
  const assignments = loadIds.length
    ? await supabase.from("dispatch_assignments").select("*").in("load_id", loadIds).order("created_at", { ascending: false })
    : { data: [], error: null };
  if (assignments.error) throw new Error(`Could not load assignments: ${assignments.error.message}`);

  const qualsByDriver = new Map<string, BoardDriver["qualifications"]>();
  for (const q of (quals.data ?? []) as Array<QualificationRow>) {
    qualsByDriver.set(q.driver_id, [...(qualsByDriver.get(q.driver_id) ?? []), { kind: q.kind, cdl_class: q.cdl_class, expires_on: q.expires_on, verified_at: q.verified_at }]);
  }

  return {
    date,
    today,
    timezone,
    orders: orderRows,
    loads: loadRows,
    assignments: (assignments.data ?? []) as AssignmentRow[],
    trucks: (trucks.data ?? []) as BoardTruck[],
    trailers: (trailers.data ?? []) as BoardTrailer[],
    drivers: ((drivers.data ?? []) as Array<Pick<DriverListRow, "id" | "display_name" | "active">>).map((d) => ({ ...d, qualifications: qualsByDriver.get(d.id) ?? [] })),
    units: (units.data ?? []) as UnitRow[],
  };
}

export type DispatchDay = Awaited<ReturnType<typeof getDispatchDay>>;

/** Loads and assignments of one order (order page). */
export async function getOrderDispatch(orderId: string) {
  const supabase = await createClient();
  const [loads, assignments, trucks, trailers, drivers] = await Promise.all([
    supabase.from("order_loads").select("*").eq("order_id", orderId).order("load_date").order("start_time"),
    supabase.from("dispatch_assignments").select("*").eq("order_id", orderId).eq("status", "active"),
    supabase.from("trucks").select("id, unit_number"),
    supabase.from("trailers").select("id, unit_number"),
    supabase.from("driver_list").select("id, display_name"),
  ]);
  const name = <T extends { id: string }>(rows: T[] | null, key: keyof T) => new Map((rows ?? []).map((r) => [r.id, String(r[key])]));
  return {
    loads: (loads.data ?? []) as OrderLoadRow[],
    assignments: (assignments.data ?? []) as AssignmentRow[],
    truckNames: name(trucks.data as Array<{ id: string; unit_number: string }> | null, "unit_number"),
    trailerNames: name(trailers.data as Array<{ id: string; unit_number: string }> | null, "unit_number"),
    driverNames: name(drivers.data as Array<{ id: string; display_name: string }> | null, "display_name"),
  };
}

/** Today's planned loads without an active assignment (dashboard). */
export async function countUnassignedLoadsToday(): Promise<number | null> {
  const supabase = await createClient();
  const { today } = await businessToday();
  const loads = await supabase.from("order_loads").select("id").eq("load_date", today).eq("status", "planned");
  if (loads.error) return null;
  const ids = (loads.data ?? []).map((l) => l.id as string);
  if (!ids.length) return 0;
  const assigned = await supabase.from("dispatch_assignments").select("load_id").eq("status", "active").in("load_id", ids);
  if (assigned.error) return null;
  const done = new Set((assigned.data ?? []).map((a) => a.load_id as string));
  return ids.filter((id) => !done.has(id)).length;
}
