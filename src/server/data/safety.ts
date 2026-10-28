import "server-only";
import type { IncidentKind, IncidentSeverity, IncidentStatus } from "@/lib/safety";
import { uuid } from "@/lib/schemas/common";
import { createClient } from "@/server/supabase/server";

// Safety incidents (B103, migration 20261120004300), read with the person's own session: RLS limits the incidents to
// their company and to safety.view; drivers read only their own reports' status (my_safety_reports). Before the
// migration is installed every loader says so instead of failing.

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export interface IncidentRow {
  id: string;
  number: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  status: IncidentStatus;
  occurred_at: string;
  location: string;
  description: string;
  injury: boolean;
  vehicle_damage: boolean;
  truck: string | null;
  driver: string | null;
  open_actions: number;
  overdue_actions: number;
}

export interface IncidentList { installed: boolean; rows: IncidentRow[] }

export async function listIncidents(filter: { status?: string; q?: string }, today: string): Promise<IncidentList> {
  const supabase = await createClient();
  let q = supabase
    .from("safety_incidents")
    .select("id, number, kind, severity, status, occurred_at, location, description, injury, vehicle_damage, trucks(unit_number), drivers(name), safety_incident_actions(status, due_on)")
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (filter.status === "open") q = q.neq("status", "closed");
  else if (filter.status && ["reported", "investigating", "actions_open", "closed"].includes(filter.status)) q = q.eq("status", filter.status);
  const { data, error } = await q;
  if (error) {
    if (MISSING.has(error.code ?? "")) return { installed: false, rows: [] };
    throw new Error(`Could not load incidents: ${error.message}`);
  }
  type Raw = Omit<IncidentRow, "truck" | "driver" | "open_actions" | "overdue_actions"> & {
    trucks: { unit_number: string } | null; drivers: { name: string } | null; safety_incident_actions: Array<{ status: string; due_on: string | null }>;
  };
  let rows = ((data ?? []) as unknown as Raw[]).map((r) => {
    const open = r.safety_incident_actions.filter((a) => a.status === "open");
    return {
      id: r.id, number: r.number, kind: r.kind, severity: r.severity, status: r.status, occurred_at: r.occurred_at, location: r.location,
      description: r.description, injury: r.injury, vehicle_damage: r.vehicle_damage, truck: r.trucks?.unit_number ?? null, driver: r.drivers?.name ?? null,
      open_actions: open.length, overdue_actions: open.filter((a) => a.due_on && a.due_on < today).length,
    };
  });
  const term = filter.q?.trim().toLowerCase();
  if (term) rows = rows.filter((r) => [r.number, r.location, r.description, r.truck ?? "", r.driver ?? ""].some((v) => v.toLowerCase().includes(term)));
  return { installed: true, rows };
}

export interface IncidentDetail extends IncidentRow {
  reported_at: string;
  reported_by: string | null;
  findings: string;
  root_cause: string;
  closed_at: string | null;
  closed_note: string;
  order_number: string | null;
  witnesses: Array<{ id: string; name: string; phone: string; statement: string; added_at: string }>;
  actions: Array<{ id: string; description: string; assigned_to: string | null; due_on: string | null; status: "open" | "done"; done_at: string | null; done_note: string }>;
  photos: Array<{ id: string }>;
  events: Array<{ id: number; at: string; actor: string | null; action: string; note: string }>;
}

export async function getIncident(id: string): Promise<IncidentDetail | null> {
  if (!uuid.safeParse(id).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("safety_incidents")
    .select(`id, number, kind, severity, status, occurred_at, location, description, injury, vehicle_damage, reported_at, reported_by, findings, root_cause,
      closed_at, closed_note, trucks(unit_number), drivers(name), orders(order_number),
      safety_incident_witnesses(id, name, phone, statement, added_at),
      safety_incident_actions(id, description, assigned_to, due_on, status, done_at, done_note, created_at),
      safety_incident_photos(id, created_at),
      safety_incident_events(id, at, actor, action, note)`)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    if (MISSING.has(error.code ?? "")) return null;
    throw new Error(`Could not load the incident: ${error.message}`);
  }
  if (!data) return null;
  const r = data as unknown as Record<string, unknown> & {
    trucks: { unit_number: string } | null; drivers: { name: string } | null; orders: { order_number: string } | null;
    safety_incident_witnesses: IncidentDetail["witnesses"];
    safety_incident_actions: Array<IncidentDetail["actions"][number] & { created_at: string }>;
    safety_incident_photos: Array<{ id: string; created_at: string }>;
    safety_incident_events: IncidentDetail["events"];
  };
  const actions = [...r.safety_incident_actions].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const open = actions.filter((a) => a.status === "open");
  return {
    ...(r as unknown as IncidentRow),
    reported_at: r.reported_at as string, reported_by: (r.reported_by as string | null) ?? null, findings: r.findings as string, root_cause: r.root_cause as string,
    closed_at: (r.closed_at as string | null) ?? null, closed_note: r.closed_note as string,
    truck: r.trucks?.unit_number ?? null, driver: r.drivers?.name ?? null, order_number: r.orders?.order_number ?? null,
    open_actions: open.length, overdue_actions: 0,
    witnesses: [...r.safety_incident_witnesses].sort((a, b) => a.added_at.localeCompare(b.added_at)),
    actions,
    photos: [...r.safety_incident_photos].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((p) => ({ id: p.id })),
    events: [...r.safety_incident_events].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id),
  };
}

export interface MyReport { id: string; number: string; kind: IncidentKind; severity: IncidentSeverity; occurred_at: string; status: IncidentStatus; photos: number }

/** The signed-in person's own reports (status only). Null before the migration is installed. */
export async function myReports(): Promise<MyReport[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_safety_reports");
  if (error) return null;
  return (data ?? []) as MyReport[];
}

/** Choices for the report form: active trucks and drivers of the company (RLS). */
export async function reportOptions() {
  const supabase = await createClient();
  const [trucks, drivers] = await Promise.all([
    supabase.from("trucks").select("id, unit_number").eq("active", true).order("unit_number").limit(500),
    supabase.from("driver_list").select("id, display_name").eq("active", true).order("display_name").limit(500),
  ]);
  return {
    trucks: ((trucks.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => ({ value: t.id, label: t.unit_number })),
    drivers: ((drivers.data ?? []) as Array<{ id: string; display_name: string }>).map((d) => ({ value: d.id, label: d.display_name })),
  };
}
