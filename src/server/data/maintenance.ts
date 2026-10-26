import "server-only";
import { createClient } from "@/server/supabase/server";
import { referenceKey } from "@/lib/search";
import { idsClause, ilikePattern, PAGE_SIZE, REF_KEYS, referenceMatches } from "@/server/data/search";
import type { ClearanceStatus, CostKind, PmState, WoCategory, WoStatus, WoUrgency } from "@/lib/maintenance";
import { OPEN_STATUSES } from "@/lib/maintenance";
import { parseBaseFilter } from "@/server/data/bases";

export interface WorkOrderRow {
  id: string;
  number: string;
  truck_id: string | null;
  /** Absent until migration 20261115000100 (trailer work orders) is applied. */
  trailer_id?: string | null;
  driver_id: string | null;
  field_report_id: string | null;
  schedule_id: string | null;
  title: string;
  description: string;
  category: WoCategory;
  urgency: WoUrgency;
  safety_critical: boolean;
  status: WoStatus;
  assigned_to: string | null;
  scheduled_for: string | null;
  due_on: string | null;
  findings: string;
  labor_hours: number | null;
  odometer_at_service: number | null;
  engine_hours_at_service: number | null;
  restricted_truck: boolean;
  clearance_status: ClearanceStatus | null;
  inspector_id: string | null;
  cleared_by: string | null;
  cleared_at: string | null;
  clearance_notes: string;
  completed_at: string | null;
  closed_at: string | null;
  cancel_reason: string;
  source: "manual" | "field_report" | "preventive";
  edit_seq: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TruckOption {
  id: string;
  unit_number: string;
  active: boolean;
  service_status: "in_service" | "out_of_service";
  out_of_service_reason: string;
  out_of_service_since: string | null;
  expected_return_date: string | null;
}

export interface PmRow {
  schedule_id: string;
  truck_id: string;
  unit_number: string;
  name: string;
  interval_days: number | null;
  interval_miles: number | null;
  interval_hours: number | null;
  last_done_on: string | null;
  last_done_miles: number | null;
  last_done_hours: number | null;
  next_due_on: string | null;
  next_due_miles: number | null;
  next_due_hours: number | null;
  current_miles: number | null;
  miles_read_at: string | null;
  current_hours: number | null;
  hours_read_at: string | null;
  days_state: PmState | null;
  miles_state: PmState | null;
  hours_state: PmState | null;
  state: PmState;
  readings_stale: boolean;
  open_work_order_id: string | null;
  open_work_order_number: string | null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toWorkOrder(r: Record<string, unknown>): WorkOrderRow {
  const w = r as unknown as WorkOrderRow;
  return { ...w, labor_hours: num(r.labor_hours), odometer_at_service: num(r.odometer_at_service), engine_hours_at_service: num(r.engine_hours_at_service) };
}

/** Trucks of the company (fleet registry; visible with fleet.view). */
export async function listTrucks(): Promise<TruckOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("trucks")
    .select("id, unit_number, active, service_status, out_of_service_reason, out_of_service_since, expected_return_date").order("unit_number");
  if (error) throw new Error(`Could not load trucks: ${error.message}`);
  return (data ?? []) as TruckOption[];
}

export interface TrailerOption {
  id: string;
  unit_number: string;
  active: boolean;
  service_status: "in_service" | "out_of_service";
  out_of_service_reason: string;
  out_of_service_since: string | null;
  default_truck_id: string | null;
}

/** Trailers of the company (fleet registry; visible with fleet.view). */
export async function listTrailers(): Promise<TrailerOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("trailers")
    .select("id, unit_number, active, service_status, out_of_service_reason, out_of_service_since, default_truck_id").order("unit_number");
  if (error) throw new Error(`Could not load trailers: ${error.message}`);
  return (data ?? []) as TrailerOption[];
}

/** Whether work orders can belong to a trailer here (migration 20261115000100 applied). */
export async function trailerWorkOrdersAvailable(): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.from("work_orders").select("trailer_id").limit(0);
  return !error;
}

/** Drivers (id, name, primary truck) for linking a work order to a driver. */
export async function listDriverOptions(): Promise<Array<{ id: string; name: string; primary_truck_id: string | null }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("drivers").select("id, name, primary_truck_id").eq("active", true).order("name");
  if (error) throw new Error(`Could not load drivers: ${error.message}`);
  return (data ?? []) as Array<{ id: string; name: string; primary_truck_id: string | null }>;
}

/** People who can be assigned shop work: active members whose role may manage maintenance. */
export async function listAssignees(): Promise<Array<{ id: string; name: string; role: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("maintenance_assignee_options");
  if (error) throw new Error(`Could not load mechanics: ${error.message}`);
  return ((data ?? []) as Array<{ user_id: string; name: string; role: string }>).map((u) => ({ id: u.user_id, name: u.name, role: u.role }));
}

export interface WorkOrderFilters {
  q?: string;
  /** A dispatch base id: work orders on that base's trucks and trailers. */
  base?: string;
  view?: string; // open | immediate | clearance | closed | all
  status?: string;
  urgency?: string;
  category?: string;
  truck?: string;
  trailer?: string;
  assigned?: string;
  page: number;
}

export async function listWorkOrders(f: WorkOrderFilters) {
  const supabase = await createClient();
  let query = supabase.from("work_orders").select("*", { count: "exact" });
  const pattern = ilikePattern(f.q);
  if (pattern) {
    // Search number, title and truck or trailer unit.
    const [{ data: t }, { data: tr }, trailersOk, refIds] = await Promise.all([
      supabase.from("trucks").select("id").ilike("unit_number", pattern),
      supabase.from("trailers").select("id").ilike("unit_number", pattern),
      trailerWorkOrdersAvailable(),
      referenceMatches(supabase, REF_KEYS.workOrders, referenceKey(f.q)),
    ]);
    const truckIds = ((t ?? []) as Array<{ id: string }>).map((x) => x.id);
    const trailerIds = trailersOk ? ((tr ?? []) as Array<{ id: string }>).map((x) => x.id) : [];
    query = query.or([`number.ilike.${pattern}`, `title.ilike.${pattern}`,
      ...(truckIds.length ? [`truck_id.in.(${truckIds.join(",")})`] : []),
      ...(trailerIds.length ? [`trailer_id.in.(${trailerIds.join(",")})`] : [])].join(",") + idsClause(refIds));
  }
  const view = f.view || "open";
  if (f.status && f.status in { reported: 1, triaged: 1, scheduled: 1, in_progress: 1, awaiting_parts: 1, awaiting_inspection: 1, completed: 1, closed: 1, canceled: 1 }) query = query.eq("status", f.status);
  else if (view === "open") query = query.in("status", OPEN_STATUSES);
  else if (view === "immediate") query = query.in("status", OPEN_STATUSES).or("urgency.eq.immediate,safety_critical.eq.true");
  else if (view === "clearance") query = query.eq("status", "awaiting_inspection");
  else if (view === "closed") query = query.in("status", ["completed", "closed", "canceled"]);
  if (f.urgency) query = query.eq("urgency", f.urgency);
  if (f.category) query = query.eq("category", f.category);
  if (f.truck) query = query.eq("truck_id", f.truck);
  if (f.trailer && (await trailerWorkOrdersAvailable())) query = query.eq("trailer_id", f.trailer);
  const base = parseBaseFilter(f.base);
  if (base) {
    // The base of a work order is its truck's or trailer's base (read as the person, so RLS applies).
    const [{ data: bt }, { data: bl }, trailersOk] = await Promise.all([
      supabase.from("trucks").select("id").eq("base_id", base),
      supabase.from("trailers").select("id").eq("base_id", base),
      trailerWorkOrdersAvailable(),
    ]);
    const truckIds = ((bt ?? []) as Array<{ id: string }>).map((x) => x.id);
    const trailerIds = trailersOk ? ((bl ?? []) as Array<{ id: string }>).map((x) => x.id) : [];
    const units = [...(truckIds.length ? [`truck_id.in.(${truckIds.join(",")})`] : []), ...(trailerIds.length ? [`trailer_id.in.(${trailerIds.join(",")})`] : [])];
    if (!units.length) return { rows: [], total: 0 };
    query = query.or(units.join(","));
  }
  if (f.assigned === "none") query = query.is("assigned_to", null);
  else if (f.assigned) query = query.eq("assigned_to", f.assigned);
  const from = (f.page - 1) * PAGE_SIZE;
  const { data, error, count } = await query
    .order("safety_critical", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error(`Could not load work orders: ${error.message}`);
  return { rows: ((data ?? []) as Record<string, unknown>[]).map(toWorkOrder), total: count ?? 0 };
}

export async function listOpenWorkOrders(): Promise<WorkOrderRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("work_orders").select("*").in("status", OPEN_STATUSES).order("created_at").limit(500);
  if (error) throw new Error(`Could not load work orders: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toWorkOrder);
}

/** Recent clearance outcomes (cleared or failed in the last 14 days). */
export async function listRecentClearances(): Promise<WorkOrderRow[]> {
  const supabase = await createClient();
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const { data, error } = await supabase.from("work_orders").select("*")
    .in("clearance_status", ["cleared", "failed"]).gte("updated_at", since).order("updated_at", { ascending: false }).limit(50);
  if (error) throw new Error(`Could not load clearances: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toWorkOrder);
}

export interface WoEvent { id: string; kind: string; from_status: string | null; to_status: string | null; note: string; details: Record<string, unknown>; actor_id: string | null; created_at: string }
export interface WoCost { id: string; kind: CostKind; description: string; part_number: string; vendor_name: string; quantity: number; unit_cost_cents: number; created_at: string }

export async function getWorkOrder(id: string, opts: { costs: boolean }) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("work_orders").select("*").eq("id", id).maybeSingle();
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`Could not load work order: ${error.message}`);
  }
  if (!data) return null;
  const wo = toWorkOrder(data as Record<string, unknown>);
  const [events, costs, truck, trailer, driver, schedule] = await Promise.all([
    supabase.from("work_order_events").select("id, kind, from_status, to_status, note, details, actor_id, created_at").eq("work_order_id", id).order("created_at"),
    opts.costs
      ? supabase.from("work_order_costs").select("id, kind, description, part_number, vendor_name, quantity, unit_cost_cents, created_at").eq("work_order_id", id).order("created_at")
      : Promise.resolve({ data: null, error: null }),
    wo.truck_id
      ? supabase.from("trucks").select("id, unit_number, truck_type, active, service_status, out_of_service_reason, out_of_service_since, expected_return_date").eq("id", wo.truck_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    wo.trailer_id
      ? supabase.from("trailers").select("id, unit_number, trailer_type, active, service_status, out_of_service_reason, out_of_service_since, default_truck_id").eq("id", wo.trailer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    wo.driver_id ? supabase.from("drivers").select("id, name").eq("id", wo.driver_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    wo.schedule_id ? supabase.from("maintenance_schedules").select("id, name").eq("id", wo.schedule_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (events.error) throw new Error(`Could not load history: ${events.error.message}`);
  if (costs.error) throw new Error(`Could not load costs: ${costs.error.message}`);
  return {
    wo,
    events: (events.data ?? []) as WoEvent[],
    costs: costs.data === null ? null : ((costs.data ?? []) as Array<Record<string, unknown>>).map((c) => ({ ...c, quantity: Number(c.quantity), unit_cost_cents: Number(c.unit_cost_cents) }) as WoCost),
    truck: (truck.data ?? null) as TruckOption | null,
    trailer: (trailer.data ?? null) as TrailerOption | null,
    driver: (driver.data ?? null) as { id: string; name: string } | null,
    schedule: (schedule.data ?? null) as { id: string; name: string } | null,
  };
}

export async function listPmStatus(): Promise<PmRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("maintenance_pm_status");
  if (error) throw new Error(`Could not load preventive maintenance: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    ...(r as unknown as PmRow),
    interval_miles: num(r.interval_miles), interval_hours: num(r.interval_hours),
    last_done_miles: num(r.last_done_miles), last_done_hours: num(r.last_done_hours),
    next_due_miles: num(r.next_due_miles), next_due_hours: num(r.next_due_hours),
    current_miles: num(r.current_miles), current_hours: num(r.current_hours),
  }));
}

export async function getSchedule(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("maintenance_schedules").select("*").eq("id", id).maybeSingle();
  if (error) return null;
  return data as Record<string, unknown> | null;
}

/** Latest reading per truck. */
export async function latestReadings(): Promise<Map<string, { miles: number | null; milesAt: string | null; hours: number | null; hoursAt: string | null }>> {
  const supabase = await createClient();
  const { data } = await supabase.from("truck_readings").select("truck_id, odometer_miles, engine_hours, read_at").order("read_at", { ascending: false }).limit(2000);
  const out = new Map<string, { miles: number | null; milesAt: string | null; hours: number | null; hoursAt: string | null }>();
  for (const r of (data ?? []) as Array<{ truck_id: string; odometer_miles: unknown; engine_hours: unknown; read_at: string }>) {
    const cur = out.get(r.truck_id) ?? { miles: null, milesAt: null, hours: null, hoursAt: null };
    if (cur.miles === null && r.odometer_miles !== null) { cur.miles = Number(r.odometer_miles); cur.milesAt = r.read_at; }
    if (cur.hours === null && r.engine_hours !== null) { cur.hours = Number(r.engine_hours); cur.hoursAt = r.read_at; }
    out.set(r.truck_id, cur);
  }
  return out;
}
