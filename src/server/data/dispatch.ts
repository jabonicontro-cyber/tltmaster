import "server-only";
import { addDays } from "@/lib/dates";
import type { PastCrew } from "@/lib/dispatch/board";
import { createClient } from "@/server/supabase/server";
import { businessToday } from "./settings";
import { hiredIds } from "./hired-trucks";
import { liveTicketsForLoads } from "./tickets";
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
export type BoardTrailer = Pick<TrailerRow, "id" | "unit_number" | "trailer_type" | "active" | "service_status" | "out_of_service_reason" | "compatible_truck_types" | "weight_capacity" | "weight_unit" | "volume_capacity" | "volume_unit" | "capacity_verified_at"> & { default_truck_id?: string | null };
export type BoardDriver = Pick<DriverListRow, "id" | "display_name" | "active"> & { qualifications: Array<Pick<QualificationRow, "kind" | "cdl_class" | "expires_on" | "verified_at">>; /** The driver's usual truck, used to prefill a drag-and-drop assignment. */ primary_truck_id?: string | null };

/** Orders whose scheduled dates cover `date`, their loads that day, assignments and the fleet. */
/**
 * The dispatch board for one day. `base` (a validated dispatch base id) narrows the orders and their loads to that
 * base; trucks, trailers and drivers stay as the person may see them (RLS), since cross-base dispatch is a company
 * setting.
 */
export async function getDispatchDay(date: string, base: string | null = null) {
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
    supabase.from("trailers").select("id, unit_number, trailer_type, active, service_status, out_of_service_reason, compatible_truck_types, weight_capacity, weight_unit, volume_capacity, volume_unit, capacity_verified_at, default_truck_id").eq("active", true).order("unit_number"),
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
  let dayLoads = loadRows;
  if (base) {
    orderRows = orderRows.filter((o) => o.base_id === base);
    const shown = new Set(orderRows.map((o) => o.id));
    dayLoads = loadRows.filter((l) => shown.has(l.order_id));
  }

  const loadIds = dayLoads.map((l) => l.id);
  const tickets = await liveTicketsForLoads(loadIds);
  const assignments = loadIds.length
    ? await supabase.from("dispatch_assignments").select("*").in("load_id", loadIds).order("created_at", { ascending: false })
    : { data: [], error: null };
  if (assignments.error) throw new Error(`Could not load assignments: ${assignments.error.message}`);

  // B85: each driver's usual truck (drag and drop prefill) and the crews that worked the day's orders on their most
  // recent earlier day within two weeks ("copy the previous crew"). Both are optional helpers: if they cannot be read
  // the board still works without them.
  const orderIds = [...new Set(dayLoads.map((l) => l.order_id))];
  const [primary, pastLoads] = await Promise.all([
    supabase.from("drivers").select("id, primary_truck_id"),
    orderIds.length
      ? supabase.from("order_loads").select("id, order_id, load_date, starts_at").in("order_id", orderIds).lt("load_date", date).gte("load_date", addDays(date, -14)).neq("status", "canceled")
      : Promise.resolve({ data: [], error: null }),
  ]);
  const primaryByDriver = new Map(((primary.data ?? []) as Array<{ id: string; primary_truck_id: string | null }>).map((d) => [d.id, d.primary_truck_id]));
  const pastLoadRows = (pastLoads.error ? [] : pastLoads.data ?? []) as Array<{ id: string; order_id: string; load_date: string; starts_at: string }>;
  const pastAssignments = pastLoadRows.length
    ? await supabase.from("dispatch_assignments").select("load_id, truck_id, trailer_id, driver_id").in("load_id", pastLoadRows.map((l) => l.id)).eq("status", "active")
    : { data: [], error: null };
  const pastById = new Map(pastLoadRows.map((l) => [l.id, l]));
  const pastCrews: PastCrew[] = ((pastAssignments.error ? [] : pastAssignments.data ?? []) as Array<{ load_id: string; truck_id: string; trailer_id: string | null; driver_id: string }>)
    .filter((a) => pastById.has(a.load_id))
    .map((a) => ({ order_id: pastById.get(a.load_id)!.order_id, load_date: pastById.get(a.load_id)!.load_date, starts_at: pastById.get(a.load_id)!.starts_at, truck_id: a.truck_id, trailer_id: a.trailer_id, driver_id: a.driver_id }));

  const hired = await hiredIds();
  const activeRows = ((assignments.data ?? []) as AssignmentRow[]).filter((a) => a.status === "active");
  const usedTrucks = new Set(activeRows.map((a) => a.truck_id));
  const usedDrivers = new Set(activeRows.map((a) => a.driver_id));

  const qualsByDriver = new Map<string, BoardDriver["qualifications"]>();
  for (const q of (quals.data ?? []) as Array<QualificationRow>) {
    qualsByDriver.set(q.driver_id, [...(qualsByDriver.get(q.driver_id) ?? []), { kind: q.kind, cdl_class: q.cdl_class, expires_on: q.expires_on, verified_at: q.verified_at }]);
  }

  return {
    date,
    today,
    timezone,
    orders: orderRows,
    loads: dayLoads,
    /** The base filter applied, if any. */
    base,
    assignments: (assignments.data ?? []) as AssignmentRow[],
    // Hired trucks and drivers (B83) appear only on the loads they were confirmed for: they are offered, not assigned.
    trucks: ((trucks.data ?? []) as BoardTruck[]).filter((t) => !hired.trucks.has(t.id) || usedTrucks.has(t.id)),
    trailers: (trailers.data ?? []) as BoardTrailer[],
    drivers: ((drivers.data ?? []) as Array<Pick<DriverListRow, "id" | "display_name" | "active">>).filter((d) => !hired.drivers.has(d.id) || usedDrivers.has(d.id)).map((d) => ({ ...d, qualifications: qualsByDriver.get(d.id) ?? [], primary_truck_id: primaryByDriver.get(d.id) ?? null })),
    /** Crews of the day's orders on their most recent earlier day (B85). */
    pastCrews,
    units: (units.data ?? []) as UnitRow[],
    /** Live delivery tickets of the day's loads. */
    tickets,
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

export interface UnscheduledOrder {
  id: string;
  order_number: string;
  project_name: string;
  requested_date: string | null;
  confirmed_at: string | null;
  edit_seq: number;
  site_label: string;
  customers: { name: string } | null;
}

/**
 * Confirmed orders with no delivery date: they are not on any day of the
 * board until scheduled (same rule as the Command Center's
 * `order_unscheduled`). Earliest requested date first. null = could not load.
 */
export async function listUnscheduledOrders(): Promise<UnscheduledOrder[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, project_name, requested_date, confirmed_at, edit_seq, site_label, customers(name)")
    .eq("status", "confirmed")
    .is("scheduled_start", null)
    .order("requested_date", { ascending: true, nullsFirst: false })
    .order("confirmed_at", { ascending: true })
    .limit(200);
  if (error) return null;
  return (data ?? []) as unknown as UnscheduledOrder[];
}
