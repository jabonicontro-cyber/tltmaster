import "server-only";
import { addDays } from "@/lib/dates";
import { driverReadiness, EXPIRY_WARNING_DAYS } from "@/lib/fleet/eligibility";
import { TRAILER_TYPES, TRUCK_TYPES } from "@/lib/fleet/labels";
import { uuid } from "@/lib/schemas/common";
import { createClient } from "@/server/supabase/server";
import { getUserNames } from "./quotes";
import { ilikePattern } from "./search";
import { businessToday } from "./settings";
import type { AuditEventRow, DriverListRow, EquipmentStatusEventRow, QualificationRow, TrailerRow, TruckRow } from "./types";

export interface EquipmentFilters {
  q?: string;
  /** "", "in_service", "out_of_service", "inactive" — default lists active equipment */
  status?: string;
  type?: string;
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
  readiness: ReturnType<typeof driverReadiness>;
}

export interface DriverFilters {
  q?: string;
  /** "", "ready", "not_ready", "inactive", "all" — default lists active drivers */
  status?: string;
}

export async function listDrivers(filters: DriverFilters): Promise<{ rows: DriverWithReadiness[]; today: string }> {
  const supabase = await createClient();
  let query = supabase.from("driver_list").select("*").order("display_name");
  const pattern = ilikePattern(filters.q);
  if (pattern) query = query.or(`display_name.ilike.${pattern},employee_number.ilike.${pattern},phone.ilike.${pattern}`);
  if (filters.status === "inactive") query = query.eq("active", false);
  else if (filters.status !== "all") query = query.eq("active", true);
  const [{ data, error }, quals, { today }] = await Promise.all([
    query.limit(500),
    supabase.from("driver_qualifications").select("*").order("expires_on", { ascending: true, nullsFirst: true }),
    businessToday(),
  ]);
  if (error) throw new Error(`Could not load drivers: ${error.message}`);
  if (quals.error) throw new Error(`Could not load qualifications: ${quals.error.message}`);
  const byDriver = new Map<string, QualificationRow[]>();
  for (const q of (quals.data ?? []) as QualificationRow[]) byDriver.set(q.driver_id, [...(byDriver.get(q.driver_id) ?? []), q]);
  let rows = ((data ?? []) as DriverListRow[]).map((d) => {
    const qualifications = byDriver.get(d.id) ?? [];
    return { ...d, qualifications, readiness: driverReadiness({ active: d.active, qualifications }, today) };
  });
  if (filters.status === "ready") rows = rows.filter((d) => d.readiness.eligible);
  if (filters.status === "not_ready") rows = rows.filter((d) => !d.readiness.eligible);
  return { rows, today };
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

export async function fleetOverview() {
  const supabase = await createClient();
  const { today } = await businessToday();
  const [trucks, trailers, drivers] = await Promise.all([
    supabase.from("trucks").select("id, unit_number, active, service_status, out_of_service_reason, out_of_service_since, expected_return_date, weight_capacity, volume_capacity, capacity_verified_at"),
    supabase.from("trailers").select("id, unit_number, active, service_status, out_of_service_reason, out_of_service_since, expected_return_date, weight_capacity, volume_capacity, capacity_verified_at"),
    listDrivers({}),
  ]);
  if (trucks.error || trailers.error) throw new Error("Could not load the fleet.");
  type Eq = Pick<TruckRow, "id" | "unit_number" | "active" | "service_status" | "out_of_service_reason" | "out_of_service_since" | "expected_return_date" | "weight_capacity" | "volume_capacity" | "capacity_verified_at">;
  const summarize = (rows: Eq[]) => {
    const active = rows.filter((r) => r.active);
    return {
      active: active.length,
      inService: active.filter((r) => r.service_status === "in_service").length,
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
    trucks: summarize((trucks.data ?? []) as Eq[]),
    trailers: summarize((trailers.data ?? []) as Eq[]),
    drivers: {
      active: drivers.rows.length,
      ready: drivers.rows.filter((d) => d.readiness.eligible).length,
      notReady: drivers.rows.filter((d) => !d.readiness.eligible),
    },
    expiring,
  };
}
