import "server-only";
import { addDays } from "@/lib/dates";
import { documentAttention, vehicleAvailability, type DocumentKind, type OpenWorkOrder } from "@/lib/fleet/availability";
import { driverReadyOn, summarizeDriversReady, vehicleReadyOn, type DriverDayReadiness, type ReadinessTimeOff, type ReadinessWorkOrder } from "@/lib/fleet/readiness";
import type { EquipmentRowExtra } from "@/components/fleet/equipment-views";
import { driverReadiness, EXPIRY_WARNING_DAYS } from "@/lib/fleet/eligibility";
import { TRAILER_TYPES, TRUCK_TYPES } from "@/lib/fleet/labels";
import { uuid } from "@/lib/schemas/common";
import { allRows } from "@/server/data/all-rows";
import { createClient } from "@/server/supabase/server";
import { parseBaseFilter } from "@/server/data/bases";
import { hiredIds } from "./hired-trucks";
import { getUserNames } from "./quotes";
import { ilikePattern } from "./search";
import { businessToday } from "./settings";
import type { AuditEventRow, DriverListRow, EquipmentStatusEventRow, QualificationRow, TrailerRow, TruckRow } from "./types";

export interface EquipmentFilters {
  q?: string;
  /** "", "in_service", "out_of_service", "inactive" — default lists active equipment */
  status?: string;
  type?: string;
  /** A dispatch base id (validated by parseBaseFilter). */
  base?: string;
}

/** Search + status filter shared by trucks and trailers. */
function equipmentQuery<T extends "trucks" | "trailers">(table: T, filters: EquipmentFilters) {
  return async () => {
    const supabase = await createClient();
    let query = supabase.from(table).select("*").order("unit_number");
    const pattern = ilikePattern(filters.q);
    if (pattern) {
      query = query.or(`unit_number.ilike.${pattern},make.ilike.${pattern},model.ilike.${pattern},license_plate.ilike.${pattern},vin.ilike.${pattern},notes.ilike.${pattern}`);
    }
    if (filters.status === "inactive") query = query.eq("active", false);
    else if (filters.status === "all") {
      // everything
    } else {
      query = query.eq("active", true);
      if (filters.status === "in_service" || filters.status === "out_of_service") query = query.eq("service_status", filters.status);
    }
    const types: readonly string[] = table === "trucks" ? TRUCK_TYPES : TRAILER_TYPES;
    if (filters.type && types.includes(filters.type)) query = query.eq(table === "trucks" ? "truck_type" : "trailer_type", filters.type);
    const base = parseBaseFilter(filters.base);
    if (base) query = query.eq("base_id", base);
    const { data, error } = await query.limit(500);
    if (error) throw new Error(`Could not load ${table}: ${error.message}`);
    return data ?? [];
  };
}

export async function listTrucks(filters: EquipmentFilters) {
  return (await equipmentQuery("trucks", filters)()) as TruckRow[];
}

export async function listTrailers(filters: EquipmentFilters) {
  return (await equipmentQuery("trailers", filters)()) as TrailerRow[];
}

/** Truck choices for forms and the eligibility check (active first). */
export async function truckOptions() {
  const supabase = await createClient();
  const { data, error } = await supabase.from("trucks").select("id, unit_number, truck_type, active, service_status").order("active", { ascending: false }).order("unit_number");
  if (error) throw new Error(`Could not load trucks: ${error.message}`);
  return (data ?? []) as Array<Pick<TruckRow, "id" | "unit_number" | "truck_type" | "active" | "service_status">>;
}

export async function trailerOptions() {
  const supabase = await createClient();
  const { data, error } = await supabase.from("trailers").select("id, unit_number, trailer_type, active, service_status").order("active", { ascending: false }).order("unit_number");
  if (error) throw new Error(`Could not load trailers: ${error.message}`);
  return (data ?? []) as Array<Pick<TrailerRow, "id" | "unit_number" | "trailer_type" | "active" | "service_status">>;
}

async function equipmentHistory(column: "truck_id" | "trailer_id", id: string) {
  const supabase = await createClient();
  const [events, audit] = await Promise.all([
    supabase.from("equipment_status_events").select("*").eq(column, id).order("occurred_at", { ascending: false }).limit(50),
    // Only visible with audit.view (RLS); empty otherwise.
    supabase.from("audit_events").select("*").eq("entity_id", id).order("occurred_at", { ascending: false }).limit(50),
  ]);
  if (events.error) throw new Error(`Could not load history: ${events.error.message}`);
  return { events: (events.data ?? []) as EquipmentStatusEventRow[], audit: (audit.data ?? []) as AuditEventRow[] };
}

export async function getTruck(id: string) {
  if (!uuid.safeParse(id).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("trucks").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load truck: ${error.message}`);
  if (!data) return null;
  const [history, paired, names] = await Promise.all([
    equipmentHistory("truck_id", id),
    supabase.from("trailers").select("*").eq("default_truck_id", id).order("unit_number"),
    getUserNames(),
  ]);
  return { truck: data as TruckRow, ...history, pairedTrailers: (paired.data ?? []) as TrailerRow[], names };
}

export async function getTrailer(id: string) {
  if (!uuid.safeParse(id).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("trailers").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load trailer: ${error.message}`);
  if (!data) return null;
  const trailer = data as TrailerRow;
  const [history, truck, names] = await Promise.all([
    equipmentHistory("trailer_id", id),
    trailer.default_truck_id ? supabase.from("trucks").select("*").eq("id", trailer.default_truck_id).maybeSingle() : Promise.resolve({ data: null }),
    getUserNames(),
  ]);
  return { trailer, ...history, defaultTruck: (truck.data ?? null) as TruckRow | null, names };
}

export interface DriverWithReadiness extends DriverListRow {
  qualifications: QualificationRow[];
  /** Qualifications only (dispatch eligibility without a truck). */
  readiness: ReturnType<typeof driverReadiness>;
  /** Ready today by the shared driver rule (src/lib/fleet/readiness.ts): qualified and not on full-day time off. */
  today: DriverDayReadiness;
  /** A hired-truck (hauler) driver: counted apart, never in the company's own ready count. */
  hired: boolean;
}

export interface DriverFilters {
  q?: string;
  /** "", "ready", "not_ready", "hired", "inactive", "all" — default lists active drivers. Ready / not ready: own drivers today. */
  status?: string;
  base?: string;
}

/**
 * Today's approved and pending time off of every driver, for the shared driver rule. Needs dispatch.view
 * (dispatch_time_off); without it, or before the time-off update, `checked` is false and nobody counts as off.
 */
async function driverTimeOffToday(today: string): Promise<{ rows: ReadinessTimeOff[]; checked: boolean }> {
  const supabase = await createClient();
  const r = await supabase.rpc("dispatch_time_off", { p_from: today, p_to: today });
  if (r.error) return { rows: [], checked: false };
  return { rows: (r.data ?? []) as ReadinessTimeOff[], checked: true };
}

export async function listDrivers(filters: DriverFilters): Promise<{ rows: DriverWithReadiness[]; today: string; timeOffChecked: boolean; timeOff: ReadinessTimeOff[] }> {
  const supabase = await createClient();
  let query = supabase.from("driver_list").select("*").order("display_name");
  const pattern = ilikePattern(filters.q);
  if (pattern) query = query.or(`display_name.ilike.${pattern},employee_number.ilike.${pattern},phone.ilike.${pattern}`);
  if (filters.status === "inactive") query = query.eq("active", false);
  else if (filters.status !== "all") query = query.eq("active", true);
  const base = parseBaseFilter(filters.base);
  if (base) query = query.eq("base_id", base);
  const { today } = await businessToday();
  const [{ data, error }, quals, hired, leave] = await Promise.all([
    query.limit(500),
    supabase.from("driver_qualifications").select("*").order("expires_on", { ascending: true, nullsFirst: true }),
    hiredIds(),
    driverTimeOffToday(today),
  ]);
  if (error) throw new Error(`Could not load drivers: ${error.message}`);
  if (quals.error) throw new Error(`Could not load qualifications: ${quals.error.message}`);
  const byDriver = new Map<string, QualificationRow[]>();
  for (const q of (quals.data ?? []) as QualificationRow[]) byDriver.set(q.driver_id, [...(byDriver.get(q.driver_id) ?? []), q]);
  let rows = ((data ?? []) as DriverListRow[]).map((d) => {
    const qualifications = byDriver.get(d.id) ?? [];
    const isHired = hired.drivers.has(d.id);
    return {
      ...d,
      qualifications,
      readiness: driverReadiness({ active: d.active, qualifications }, today),
      today: driverReadyOn({ id: d.id, active: d.active, qualifications, hired: isHired }, leave.rows, today),
      hired: isHired,
    };
  });
  if (filters.status === "ready") rows = rows.filter((d) => !d.hired && d.today.ready);
  if (filters.status === "not_ready") rows = rows.filter((d) => !d.hired && !d.today.ready);
  if (filters.status === "hired") rows = rows.filter((d) => d.hired);
  return { rows, today, timeOffChecked: leave.checked, timeOff: leave.rows };
}

export async function driverOptions() {
  const supabase = await createClient();
  const { data, error } = await supabase.from("driver_list").select("id, display_name, active").order("active", { ascending: false }).order("display_name");
  if (error) throw new Error(`Could not load drivers: ${error.message}`);
  return (data ?? []) as Array<Pick<DriverListRow, "id" | "display_name" | "active">>;
}

export async function getDriver(id: string) {
  if (!uuid.safeParse(id).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.from("driver_list").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load driver: ${error.message}`);
  if (!data) return null;
  const [quals, names, { today }] = await Promise.all([
    supabase.from("driver_qualifications").select("*").eq("driver_id", id).order("kind").order("expires_on", { ascending: false, nullsFirst: false }),
    getUserNames(),
    businessToday(),
  ]);
  if (quals.error) throw new Error(`Could not load qualifications: ${quals.error.message}`);
  // The driver's own entries, its qualifications' entries, and removed qualifications (their details carry driver_id).
  const ids = [id, ...((quals.data ?? []) as QualificationRow[]).map((q) => q.id)];
  const audit = await supabase
    .from("audit_events")
    .select("*")
    .or(`entity_id.in.(${ids.join(",")}),details->>driver_id.eq.${id}`)
    .order("occurred_at", { ascending: false })
    .limit(100);
  const driver = data as DriverListRow;
  const qualifications = (quals.data ?? []) as QualificationRow[];
  return { driver, qualifications, readiness: driverReadiness({ active: driver.active, qualifications }, today), audit: (audit.data ?? []) as AuditEventRow[], names, today };
}

/** People in the company who can be linked as drivers (not linked yet), plus the current link. */
export async function linkableUsers(currentUserId: string | null = null) {
  const supabase = await createClient();
  const [people, linked] = await Promise.all([supabase.rpc("user_directory"), supabase.from("drivers").select("user_id").not("user_id", "is", null)]);
  if (people.error) throw new Error(`Could not load users: ${people.error.message}`);
  const taken = new Set(((linked.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
  return ((people.data ?? []) as Array<{ id: string; full_name: string }>)
    .filter((p) => p.id === currentUserId || !taken.has(p.id))
    .map((p) => ({ id: p.id, name: p.full_name || "Unnamed user" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fleet at a glance. `shop` says how this person may read today's shop work for the shared readiness rule
 * (src/lib/fleet/readiness.ts): "maintenance" reads open work orders (RLS: maintenance.view), "dispatch" the dispatch
 * shop schedule (dispatch.view). Without either, readiness is not computed (`readyToday` is null) rather than guessed.
 */
export async function fleetOverview(opts: { shop?: "maintenance" | "dispatch" | null } = {}) {
  const supabase = await createClient();
  const { today } = await businessToday();
  type ShopRow = ReadinessWorkOrder & { truck_id: string | null; trailer_id: string | null };
  const shopRead = async (): Promise<ShopRow[] | null> => {
    if (opts.shop === "maintenance") {
      const r = await withNewColumns((x) => supabase.from("work_orders").select(`truck_id, trailer_id, number, status, scheduled_for, safety_critical${x}`)
        .in("status", ["reported", "triaged", "scheduled", "in_progress", "awaiting_parts", "awaiting_inspection"]).limit(2000), STARTED);
      return r.error ? null : ((r.data ?? []) as ShopRow[]);
    }
    if (opts.shop === "dispatch") {
      const r = await supabase.rpc("dispatch_shop_schedule", { p_from: today, p_to: today });
      return r.error ? null : ((r.data ?? []) as ShopRow[]);
    }
    return null;
  };
  const [trucks, trailers, drivers, shop] = await Promise.all([
    supabase.from("trucks").select("id, unit_number, active, service_status, out_of_service_reason, out_of_service_since, expected_return_date, weight_capacity, volume_capacity, capacity_verified_at"),
    supabase.from("trailers").select("id, unit_number, active, service_status, out_of_service_reason, out_of_service_since, expected_return_date, weight_capacity, volume_capacity, capacity_verified_at"),
    listDrivers({}),
    shopRead(),
  ]);
  if (trucks.error || trailers.error) throw new Error("Could not load the fleet.");
  type Eq = Pick<TruckRow, "id" | "unit_number" | "active" | "service_status" | "out_of_service_reason" | "out_of_service_since" | "expected_return_date" | "weight_capacity" | "volume_capacity" | "capacity_verified_at">;
  const summarize = (rows: Eq[], kind: "truck" | "trailer") => {
    const active = rows.filter((r) => r.active);
    const byUnit = new Map<string, ShopRow[]>();
    for (const w of shop ?? []) {
      const id = kind === "truck" ? w.truck_id : w.trailer_id;
      if (id) byUnit.set(id, [...(byUnit.get(id) ?? []), w]);
    }
    return {
      active: active.length,
      inService: active.filter((r) => r.service_status === "in_service").length,
      /** Can run today by the shared readiness rule; null when shop work could not be read. */
      readyToday: shop === null ? null : active.filter((r) => vehicleReadyOn(r, byUnit.get(r.id) ?? [], today, today).ready).length,
      outOfService: active.filter((r) => r.service_status === "out_of_service"),
      capacityUnknown: active.filter((r) => r.weight_capacity === null && r.volume_capacity === null).length,
      capacityUnverified: active.filter((r) => (r.weight_capacity !== null || r.volume_capacity !== null) && !r.capacity_verified_at).length,
    };
  };
  const limit = addDays(today, EXPIRY_WARNING_DAYS);
  const expiring = drivers.rows.flatMap((d) =>
    d.qualifications.filter((q) => q.expires_on !== null && q.expires_on <= limit).map((q) => ({ driver: d, qualification: q })),
  );
  expiring.sort((a, b) => (a.qualification.expires_on! < b.qualification.expires_on! ? -1 : 1));
  return {
    today,
    trucks: summarize((trucks.data ?? []) as Eq[], "truck"),
    trailers: summarize((trailers.data ?? []) as Eq[], "trailer"),
    drivers: {
      /** Every active driver, hired ones included. */
      active: drivers.rows.length,
      /** Today by the shared driver rule: own drivers (total, ready, not qualified, off) and hired drivers apart. */
      today: summarizeDriversReady(drivers.rows.map((d) => ({ id: d.id, active: d.active, qualifications: d.qualifications, hired: d.hired })), drivers.timeOff, today),
      /** Whether time off was read (dispatch.view); without it nobody counts as off. */
      timeOffChecked: drivers.timeOffChecked,
      /** Not qualified today (qualifications), for the attention list. */
      notReady: drivers.rows.filter((d) => !d.readiness.eligible),
    },
    expiring,
  };
}

// -----------------------------------------------------------------------------
// Fleet management context: assignments, maintenance, documents.
// Each source is optional: when its tables are not installed yet (migration not
// applied) or the user may not read it, the page says so instead of failing.
// -----------------------------------------------------------------------------

export interface VehicleDocumentRow {
  id: string;
  truck_id: string | null;
  trailer_id: string | null;
  kind: DocumentKind;
  title: string;
  reference_number: string;
  issuing_authority: string;
  issued_on: string | null;
  expires_on: string | null;
  notes: string;
  archived_at: string | null;
  archived_by: string | null;
  created_by: string | null;
  created_at: string;
  /** A person confirmed the record (20261112000200); absent before that update is installed. */
  verified_at?: string | null;
  /** The work order the shop recorded this certificate from (20261120015200); the office checks such a record. */
  work_order_id?: string | null;
}

export type DocumentRule = "block" | "warn";
/** The company's rule per checked document kind (20261112000200), or null when not installed. */
export async function documentRules(): Promise<Record<"registration" | "insurance" | "inspection" | "permit", DocumentRule> | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("document_rules");
  if (error) return null;
  return data as Record<"registration" | "insurance" | "inspection" | "permit", DocumentRule>;
}

type Optional<T> = { available: boolean; rows: T[] };

type Read = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

/**
 * Read with columns a recent database update added (`extra`, e.g. ", work_started_at"), and again without them when
 * the database does not have them yet (42703): the page then works as before that update.
 */
async function withNewColumns(run: (extra: string) => Read, extra: string): Promise<Awaited<Read>> {
  const first = await run(extra);
  return first.error?.code === "42703" ? run("") : first;
}

/** Started (20261120015000) is read with every open work order the readiness rule needs. */
const STARTED = ", work_started_at";

async function optionalRows<T>(run: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>): Promise<Optional<T>> {
  try {
    const { data, error } = await run();
    if (error) return { available: false, rows: [] };
    return { available: true, rows: (data ?? []) as T[] };
  } catch {
    return { available: false, rows: [] };
  }
}

export interface FleetContext {
  today: string;
  /** primary truck id → driver */
  driverByTruck: Map<string, { id: string; name: string }>;
  maintenance: { available: boolean; openByTruck: Map<string, OpenWorkOrder[]>; pmByTruck: Map<string, { overdue: number; dueSoon: number; unknown: number }> };
  documents: { available: boolean; byVehicle: Map<string, VehicleDocumentRow[]> };
}

export async function fleetContext(opts: { maintenance: boolean }): Promise<FleetContext> {
  const supabase = await createClient();
  const [{ today }, drivers, open, pm, docs] = await Promise.all([
    businessToday(),
    optionalRows<{ id: string; name: string; primary_truck_id: string | null }>(() =>
      supabase.from("drivers").select("id, name, primary_truck_id").eq("active", true).not("primary_truck_id", "is", null)),
    opts.maintenance
      ? optionalRows<OpenWorkOrder & { truck_id: string | null }>(() =>
          withNewColumns((x) => supabase.from("work_orders").select(`id, number, title, status, safety_critical, scheduled_for, clearance_status, truck_id${x}`)
            .in("status", ["reported", "triaged", "scheduled", "in_progress", "awaiting_parts", "awaiting_inspection"]).limit(1000), STARTED))
      : Promise.resolve({ available: false, rows: [] }),
    opts.maintenance
      ? optionalRows<{ truck_id: string; state: string; readings_stale: boolean }>(() => supabase.rpc("maintenance_pm_status"))
      : Promise.resolve({ available: false, rows: [] }),
    optionalRows<VehicleDocumentRow>(() => allRows(() => supabase.from("vehicle_documents").select("*").is("archived_at", null).order("expires_on", { ascending: true, nullsFirst: false }).order("id"))),
  ]);
  // Parts still on order (20261120012300), for the "Part on order: …, expected …" note; none when it cannot be read.
  const waiting = opts.maintenance && open.rows.some((w) => w.status === "awaiting_parts")
    ? await optionalRows<{ work_order_id: string; description: string; expected_on: string | null }>(() => supabase.rpc("part_waits", { p_work_order: null }))
    : { available: false, rows: [] };
  for (const w of open.rows) {
    const parts = waiting.rows.filter((p) => p.work_order_id === w.id);
    if (parts.length) w.parts = parts.map((p) => ({ description: p.description, expected_on: p.expected_on }));
  }
  const driverByTruck = new Map(drivers.rows.map((d) => [d.primary_truck_id!, { id: d.id, name: d.name }]));
  const openByTruck = new Map<string, OpenWorkOrder[]>();
  // Truck work orders only; a trailer's open work orders are read on its own profile.
  for (const w of open.rows) if (w.truck_id) openByTruck.set(w.truck_id, [...(openByTruck.get(w.truck_id) ?? []), w]);
  const pmByTruck = new Map<string, { overdue: number; dueSoon: number; unknown: number }>();
  for (const p of pm.rows) {
    const cur = pmByTruck.get(p.truck_id) ?? { overdue: 0, dueSoon: 0, unknown: 0 };
    if (p.state === "overdue") cur.overdue += 1;
    else if (p.state === "due_soon") cur.dueSoon += 1;
    else if (p.state === "unknown" || p.readings_stale) cur.unknown += 1;
    pmByTruck.set(p.truck_id, cur);
  }
  const byVehicle = new Map<string, VehicleDocumentRow[]>();
  for (const d of docs.rows) {
    const key = (d.truck_id ?? d.trailer_id)!;
    byVehicle.set(key, [...(byVehicle.get(key) ?? []), d]);
  }
  return {
    today,
    driverByTruck,
    maintenance: { available: open.available && pm.available, openByTruck, pmByTruck },
    documents: { available: docs.available, byVehicle },
  };
}

export interface VehicleRecords {
  documents: Optional<VehicleDocumentRow>;
  assignments: Optional<{ id: string; driver_id: string; action: "assigned" | "unassigned"; actor_id: string | null; created_at: string }>;
  workOrders: Optional<{ id: string; number: string; title: string; status: string; urgency: string; safety_critical: boolean; scheduled_for: string | null; clearance_status: string | null; created_at: string; completed_at: string | null; cleared_at: string | null; work_started_at?: string | null }>;
  schedules: Optional<{ schedule_id: string; truck_id: string; name: string; state: string; next_due_on: string | null; next_due_miles: number | null; next_due_hours: number | null; readings_stale: boolean }>;
  /**
   * `source` (20261120012200): where the reading was entered; `set_aside_*` (20261120015100): marked wrong, kept for
   * history and never the current reading. Absent before those updates.
   */
  readings: Optional<{ id: string; odometer_miles: number | null; engine_hours: number | null; read_at: string; recorded_by: string | null; source?: string; note?: string; set_aside_at?: string | null; set_aside_by?: string | null; set_aside_reason?: string }>;
  /**
   * The readings that set the truck's current reading (the highest odometer and the highest engine hours not set aside,
   * over every reading: the database's rule, 20261120015600), read apart from the newest 20 so an old high reading is
   * never hidden. Null before 20261120015100 (no set-aside column); the page then works from the loaded rows.
   */
  highestReading: { odometer: VehicleRecords["readings"]["rows"][number] | null; hours: VehicleRecords["readings"]["rows"][number] | null } | null;
  /** Readings the feed did not use (audit 'truck.reading_ignored', 20261120012200), newest first. */
  ignoredReadings: Optional<{ id: string; occurred_at: string; summary: string; details: { value?: number; current?: number; kind?: string; why?: string; source?: string } }>;
  costs: Optional<{ work_order_id: string; quantity: number; unit_cost_cents: number }>;
  driverNames: Map<string, string>;
}

/** Everything the vehicle profile shows beyond the vehicle row itself. */
export async function vehicleRecords(kind: "truck" | "trailer", id: string, opts: { maintenance: boolean; costs: boolean }): Promise<VehicleRecords> {
  const supabase = await createClient();
  const column = kind === "truck" ? "truck_id" : "trailer_id";
  const isTruck = kind === "truck";
  const none = Promise.resolve({ available: false, rows: [] as never[] });
  const [documents, assignments, workOrders, schedules, readings] = await Promise.all([
    optionalRows<VehicleDocumentRow>(() => supabase.from("vehicle_documents").select("*").eq(column, id).order("archived_at", { ascending: false, nullsFirst: true }).order("expires_on", { ascending: true, nullsFirst: false })),
    isTruck ? optionalRows<VehicleRecords["assignments"]["rows"][number]>(() => supabase.from("truck_assignment_events").select("id, driver_id, action, actor_id, created_at").eq("truck_id", id).order("created_at", { ascending: false }).limit(50)) : none,
    // Trailer work orders need 20261115000100; before it the query fails and the card says history is unavailable.
    opts.maintenance ? optionalRows<VehicleRecords["workOrders"]["rows"][number]>(() => withNewColumns((x) => supabase.from("work_orders").select(`id, number, title, status, urgency, safety_critical, scheduled_for, clearance_status, created_at, completed_at, cleared_at${x}`).eq(column, id).order("created_at", { ascending: false }).limit(100), STARTED)) : none,
    isTruck && opts.maintenance ? optionalRows<VehicleRecords["schedules"]["rows"][number]>(() => supabase.rpc("maintenance_pm_status")) : none,
    isTruck && opts.maintenance ? optionalRows<VehicleRecords["readings"]["rows"][number]>(() => supabase.from("truck_readings").select("*").eq("truck_id", id).order("read_at", { ascending: false }).limit(20)) : none,
  ]);
  const highestReading = isTruck && opts.maintenance && readings.available ? await readHighest(supabase, id) : null;
  const ignoredReadings = isTruck && opts.maintenance
    ? await optionalRows<VehicleRecords["ignoredReadings"]["rows"][number]>(() => supabase.from("audit_events").select("id, occurred_at, summary, details")
        .eq("entity_type", "truck").eq("entity_id", id).eq("action", "truck.reading_ignored").order("occurred_at", { ascending: false }).limit(10))
    : { available: false, rows: [] };
  const woIds = workOrders.rows.map((w) => w.id);
  const costs = opts.costs && woIds.length
    ? await optionalRows<VehicleRecords["costs"]["rows"][number]>(() => supabase.from("work_order_costs").select("work_order_id, quantity, unit_cost_cents").in("work_order_id", woIds))
    : { available: opts.costs && workOrders.available, rows: [] };
  const driverIds = [...new Set(assignments.rows.map((a) => a.driver_id))];
  const names = driverIds.length ? await supabase.from("drivers").select("id, name").in("id", driverIds) : { data: [] };
  return {
    documents,
    assignments,
    workOrders,
    schedules: { available: schedules.available, rows: schedules.rows.filter((r) => r.truck_id === id) },
    readings: { available: readings.available, rows: readings.rows.map(readingNumbers) },
    highestReading,
    ignoredReadings,
    costs: { available: costs.available, rows: costs.rows.map((c) => ({ ...c, quantity: Number(c.quantity), unit_cost_cents: Number(c.unit_cost_cents) })) },
    driverNames: new Map(((names.data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name])),
  };
}

type ReadingRow = VehicleRecords["readings"]["rows"][number];
const readingNumbers = (r: ReadingRow): ReadingRow => ({ ...r, odometer_miles: r.odometer_miles === null ? null : Number(r.odometer_miles), engine_hours: r.engine_hours === null ? null : Number(r.engine_hours) });

/** The highest odometer and engine-hour readings not set aside (latest among equal values), or null if unreadable. */
async function readHighest(supabase: Awaited<ReturnType<typeof createClient>>, truckId: string): Promise<VehicleRecords["highestReading"]> {
  const top = (k: "odometer_miles" | "engine_hours") => optionalRows<ReadingRow>(() => supabase.from("truck_readings").select("*").eq("truck_id", truckId)
    .is("set_aside_at", null).not(k, "is", null).order(k, { ascending: false }).order("read_at", { ascending: false }).limit(1));
  const [m, h] = await Promise.all([top("odometer_miles"), top("engine_hours")]);
  if (!m.available || !h.available) return null;
  return { odometer: m.rows[0] ? readingNumbers(m.rows[0]) : null, hours: h.rows[0] ? readingNumbers(h.rows[0]) : null };
}

/** Directory rows with assignment, availability, maintenance and document flags; filtered and sorted. */
export function buildDirectory<T extends TruckRow | TrailerRow>(
  kind: "truck" | "trailer",
  rows: T[],
  ctx: FleetContext,
  f: { driver?: string; maintenance?: string; documents?: string; ownership?: string; sort?: string },
) {
  const extras: Record<string, EquipmentRowExtra> = {};
  const facts = new Map<string, { restricted: boolean; open: number; overdue: number; dueSoon: number; expired: number; expiring: number; missing: number; driver: boolean; rank: number }>();
  for (const e of rows) {
    const open = kind === "truck" ? ctx.maintenance.openByTruck.get(e.id) ?? [] : [];
    const pm = kind === "truck" ? ctx.maintenance.pmByTruck.get(e.id) : undefined;
    const availability = vehicleAvailability(e, open, ctx.today);
    const docs = ctx.documents.byVehicle.get(e.id) ?? [];
    const att = documentAttention(docs, ctx.today);
    const driver = kind === "truck" ? ctx.driverByTruck.get(e.id)?.name ?? null : null;
    const restricted = availability.state === "restricted" || availability.state === "awaiting_clearance";
    const maintenanceText = !ctx.maintenance.available || kind === "trailer" ? null
      : pm?.overdue ? { text: `${pm.overdue} preventive service${pm.overdue === 1 ? "" : "s"} overdue`, tone: "red" as const }
      : open.length ? { text: `${open.length} open work order${open.length === 1 ? "" : "s"}`, tone: "amber" as const }
      : pm?.dueSoon ? { text: `${pm.dueSoon} preventive due soon`, tone: "amber" as const }
      : pm?.unknown ? { text: "Preventive data missing", tone: "gray" as const }
      : null;
    extras[e.id] = {
      driver,
      availability,
      maintenance: maintenanceText,
      documents: ctx.documents.available ? { expired: att.expired.length, expiring: att.expiring.length, notRecorded: att.notRecorded.map(att.label) } : null,
    };
    const rank = { restricted: 0, awaiting_clearance: 0, out_of_service: 1, in_shop: 2, available: 3, inactive: 4 }[availability.state];
    facts.set(e.id, { restricted, open: open.length, overdue: pm?.overdue ?? 0, dueSoon: pm?.dueSoon ?? 0, expired: att.expired.length, expiring: att.expiring.length, missing: att.notRecorded.length, driver: Boolean(driver), rank });
  }
  let out = rows.filter((e) => {
    const x = facts.get(e.id)!;
    if (f.driver === "assigned" && !x.driver) return false;
    if (f.driver === "unassigned" && x.driver) return false;
    if (f.maintenance === "restricted" && !x.restricted) return false;
    if (f.maintenance === "open" && !x.open) return false;
    if (f.maintenance === "overdue" && !x.overdue) return false;
    if (f.maintenance === "due_soon" && !x.dueSoon) return false;
    if (f.documents === "attention" && !(x.expired || x.expiring)) return false;
    if (f.documents === "expired" && !x.expired) return false;
    if (f.documents === "missing" && !x.missing) return false;
    if (f.ownership === "unknown" && e.ownership) return false;
    if (f.ownership && f.ownership !== "unknown" && e.ownership !== f.ownership) return false;
    return true;
  });
  const typeOf = (e: T) => ("truck_type" in e ? e.truck_type : (e as TrailerRow).trailer_type);
  if (f.sort === "type") out = [...out].sort((a, b) => typeOf(a).localeCompare(typeOf(b)) || a.unit_number.localeCompare(b.unit_number));
  else if (f.sort === "year") out = [...out].sort((a, b) => (b.model_year ?? 0) - (a.model_year ?? 0) || a.unit_number.localeCompare(b.unit_number));
  else if (f.sort === "status") out = [...out].sort((a, b) => facts.get(a.id)!.rank - facts.get(b.id)!.rank || a.unit_number.localeCompare(b.unit_number));
  return { rows: out, extras };
}

/** A truck or trailer a person took out of service whose shop work is all done (20261120015300). */
export interface UnitBackFromShop {
  kind: "truck" | "trailer";
  id: string;
  unit_number: string;
  out_of_service_reason: string;
  out_of_service_since: string;
  work_done_at: string;
  /** The last finished job; null without maintenance.view. */
  work_order_id: string | null;
  work_order_number: string | null;
}

/**
 * Units out of service whose shop work is done, for the "Put it back in service?" prompt (owner 2026-11-09, MD1).
 * Empty when the database update is not installed or the list cannot be read: the prompt is a convenience; the fleet
 * page's Return to service always works.
 */
export async function unitsBackFromShop(): Promise<UnitBackFromShop[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("units_back_from_shop");
  if (error) return [];
  return (data ?? []) as UnitBackFromShop[];
}

/** An inspection certificate the shop recorded from a work order and nobody has checked yet (20261120015200). */
export interface CertificateToCheck {
  id: string;
  kind: "truck" | "trailer";
  vehicle_id: string;
  unit_number: string;
  issued_on: string | null;
  expires_on: string | null;
  issuing_authority: string;
  reference_number: string;
  created_at: string;
}

/**
 * The office's to-do: shop-recorded inspection certificates not verified yet (owner 2026-11-09, MD1). They already
 * count for dispatch; a person checks them against the paper. `installed` is false before the database update.
 */
export async function certificatesToCheck(): Promise<{ installed: boolean; rows: CertificateToCheck[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("vehicle_documents")
    .select("id, truck_id, trailer_id, issued_on, expires_on, issuing_authority, reference_number, created_at, trucks(unit_number), trailers(unit_number)")
    .not("work_order_id", "is", null).is("verified_at", null).is("archived_at", null).order("created_at").limit(200);
  if (error) return { installed: false, rows: [] };
  type Row = {
    id: string; truck_id: string | null; trailer_id: string | null; issued_on: string | null; expires_on: string | null; issuing_authority: string;
    reference_number: string; created_at: string; trucks: { unit_number: string } | null; trailers: { unit_number: string } | null;
  };
  return {
    installed: true,
    rows: ((data ?? []) as unknown as Row[]).map((r) => ({
      id: r.id,
      kind: r.truck_id ? "truck" as const : "trailer" as const,
      vehicle_id: (r.truck_id ?? r.trailer_id)!,
      unit_number: r.trucks?.unit_number ?? r.trailers?.unit_number ?? "",
      issued_on: r.issued_on,
      expires_on: r.expires_on,
      issuing_authority: r.issuing_authority,
      reference_number: r.reference_number,
      created_at: r.created_at,
    })),
  };
}
