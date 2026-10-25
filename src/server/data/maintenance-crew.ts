import "server-only";
import { createClient } from "@/server/supabase/server";
import { OPEN_STATUSES } from "@/lib/maintenance";

// Crews, labor time and checklists on a work order (migration 20261120002900). Read through the person's session
// (maintenance.view, RLS). Before the migration is applied the loader says so instead of returning empty lists.

export interface CrewMember { userId: string; name: string; role: "lead" | "assist"; status: "assigned" | "working" | "paused" | "done" }
export interface TimeEntry {
  id: string; userId: string; name: string; startedAt: string; endedAt: string | null; minutes: number | null;
  source: "timer" | "manual"; note: string; voided: boolean; voidReason: string;
}
export interface WoTask { id: string; title: string; status: "open" | "done" | "skipped"; doneBy: string | null; doneAt: string | null }
export interface MechanicOption { userId: string; name: string }

export interface WorkOrderCrew {
  installed: boolean;
  crew: CrewMember[];
  time: TimeEntry[];
  tasks: WoTask[];
  options: MechanicOption[];
  /** The signed-in person's running timer anywhere, if any. */
  myTimer: { workOrderId: string; number: string; startedAt: string } | null;
  totalMinutes: number;
}

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export async function getWorkOrderCrew(workOrderId: string, userId: string): Promise<WorkOrderCrew> {
  const supabase = await createClient();
  const [crew, time, tasks, options, mine] = await Promise.all([
    supabase.from("work_order_mechanics").select("user_id, role, status").eq("work_order_id", workOrderId),
    supabase.from("work_order_time_entries").select("id, user_id, started_at, ended_at, source, note, voided_at, void_reason").eq("work_order_id", workOrderId).order("started_at", { ascending: false }),
    supabase.from("work_order_tasks").select("id, title, status, done_by, done_at").eq("work_order_id", workOrderId).order("position"),
    supabase.rpc("maintenance_assignee_options"),
    supabase.from("work_order_time_entries").select("work_order_id, started_at, work_orders(number)").eq("user_id", userId).is("ended_at", null).is("voided_at", null).maybeSingle(),
  ]);
  if (crew.error && MISSING.has(crew.error.code ?? "")) {
    return { installed: false, crew: [], time: [], tasks: [], options: [], myTimer: null, totalMinutes: 0 };
  }
  const opts = ((options.data ?? []) as Array<{ user_id: string; name: string }>).map((o) => ({ userId: o.user_id, name: o.name }));
  const nameOf = (id: string) => opts.find((o) => o.userId === id)?.name ?? "Former member";
  const timeRows = ((time.data ?? []) as Array<{ id: string; user_id: string; started_at: string; ended_at: string | null; source: "timer" | "manual"; note: string; voided_at: string | null; void_reason: string }>).map((t) => ({
    id: t.id, userId: t.user_id, name: nameOf(t.user_id), startedAt: t.started_at, endedAt: t.ended_at,
    minutes: t.ended_at ? Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 60000) : null,
    source: t.source, note: t.note, voided: Boolean(t.voided_at), voidReason: t.void_reason,
  }));
  const m = mine.data as { work_order_id: string; started_at: string; work_orders: { number: string } | null } | null;
  return {
    installed: true,
    crew: ((crew.data ?? []) as Array<{ user_id: string; role: "lead" | "assist"; status: CrewMember["status"] }>)
      .map((c) => ({ userId: c.user_id, name: nameOf(c.user_id), role: c.role, status: c.status }))
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "lead" ? -1 : 1)),
    time: timeRows,
    tasks: ((tasks.data ?? []) as Array<{ id: string; title: string; status: WoTask["status"]; done_by: string | null; done_at: string | null }>)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, doneBy: t.done_by ? nameOf(t.done_by) : null, doneAt: t.done_at })),
    options: opts,
    myTimer: m ? { workOrderId: m.work_order_id, number: m.work_orders?.number ?? "another work order", startedAt: m.started_at } : null,
    totalMinutes: timeRows.filter((t) => !t.voided && t.minutes !== null).reduce((s, t) => s + (t.minutes ?? 0), 0),
  };
}

export interface MechanicLoad {
  userId: string;
  name: string;
  leadJobs: number;
  helperJobs: number;
  working: { workOrderId: string; number: string; since: string } | null;
  weekMinutes: number;
}

/** Each mechanic's open jobs (as lead or helper), what they are working on now, and the time they logged this week. */
export async function listShopWorkload(openWorkOrderIds: string[], weekStartIso: string): Promise<{ installed: boolean; mechanics: MechanicLoad[] }> {
  const supabase = await createClient();
  const [crew, running, week, options] = await Promise.all([
    openWorkOrderIds.length
      ? supabase.from("work_order_mechanics").select("user_id, role, work_order_id").in("work_order_id", openWorkOrderIds)
      : supabase.from("work_order_mechanics").select("user_id, role, work_order_id").limit(0),
    supabase.from("work_order_time_entries").select("user_id, work_order_id, started_at, work_orders(number)").is("ended_at", null).is("voided_at", null),
    supabase.from("work_order_time_entries").select("user_id, started_at, ended_at").is("voided_at", null).gte("started_at", weekStartIso),
    supabase.rpc("maintenance_assignee_options"),
  ]);
  if (crew.error && MISSING.has(crew.error.code ?? "")) return { installed: false, mechanics: [] };
  const byId = new Map<string, MechanicLoad>();
  for (const o of (options.data ?? []) as Array<{ user_id: string; name: string }>) {
    byId.set(o.user_id, { userId: o.user_id, name: o.name, leadJobs: 0, helperJobs: 0, working: null, weekMinutes: 0 });
  }
  const get = (id: string) => byId.get(id) ?? byId.set(id, { userId: id, name: "Former member", leadJobs: 0, helperJobs: 0, working: null, weekMinutes: 0 }).get(id)!;
  for (const c of (crew.data ?? []) as Array<{ user_id: string; role: string }>) {
    const m = get(c.user_id);
    if (c.role === "lead") m.leadJobs++;
    else m.helperJobs++;
  }
  for (const r of (running.data ?? []) as unknown as Array<{ user_id: string; work_order_id: string; started_at: string; work_orders: { number: string } | null }>) {
    get(r.user_id).working = { workOrderId: r.work_order_id, number: r.work_orders?.number ?? "", since: r.started_at };
  }
  const now = Date.now();
  for (const t of (week.data ?? []) as Array<{ user_id: string; started_at: string; ended_at: string | null }>) {
    get(t.user_id).weekMinutes += Math.round(((t.ended_at ? Date.parse(t.ended_at) : now) - Date.parse(t.started_at)) / 60000);
  }
  return {
    installed: true,
    mechanics: [...byId.values()].sort((a, b) => Number(Boolean(b.working)) - Number(Boolean(a.working)) || (b.leadJobs + b.helperJobs) - (a.leadJobs + a.helperJobs) || a.name.localeCompare(b.name)),
  };
}

export interface CapacityDay {
  date: string;
  working_day: boolean;
  mechanics: number;
  available_hours: number;
  planned_hours: number;
  jobs: number;
  unestimated: number;
  bays: number;
  skill_gaps: Array<{ id: string; number: string; category: string }>;
}

export type ShopCapacity =
  | { installed: false }
  | { installed: true; configured: false }
  | { installed: true; configured: true; bays: number; shift_start: string; shift_end: string; work_days: number[]; skills_recorded: boolean; days: CapacityDay[] };

/** The shop's daily capacity (20261120003000): available mechanic-hours against estimated scheduled work and bays. */
export async function getShopCapacity(from: string, days: number): Promise<ShopCapacity> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("maintenance_capacity", { p_from: from, p_days: days });
  if (error) {
    if (MISSING.has(error.code ?? "")) return { installed: false };
    throw new Error(`Could not load shop capacity: ${error.message}`);
  }
  return { installed: true, ...(data as { configured: boolean }) } as ShopCapacity;
}

/** Each mechanic's recorded skills (work order categories). */
export async function listMechanicSkills(): Promise<Map<string, string[]>> {
  const supabase = await createClient();
  const { data } = await supabase.from("mechanic_skills").select("user_id, category");
  const out = new Map<string, string[]>();
  for (const r of (data ?? []) as Array<{ user_id: string; category: string }>) out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.category]);
  return out;
}

export interface TriageRow {
  id: string;
  source: "rules" | "ai";
  model: string;
  status: "suggested" | "accepted" | "edited" | "rejected" | "superseded";
  suggestion: import("@/lib/maintenance-triage").TriageSuggestion;
  decision: { category?: string | null; urgency?: string | null; safety_critical?: boolean | null };
  decisionNote: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** The latest triage suggestion on a work order (20261120003100), or null; installed false before the migration. */
export async function getLatestTriage(workOrderId: string): Promise<{ installed: boolean; triage: TriageRow | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("work_order_triage")
    .select("id, source, model, status, suggestion, decision, decision_note, decided_by, decided_at, created_at")
    .eq("work_order_id", workOrderId).neq("status", "superseded").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return { installed: !MISSING.has(error.code ?? ""), triage: null };
  const r = data as { id: string; source: TriageRow["source"]; model: string; status: TriageRow["status"]; suggestion: TriageRow["suggestion"]; decision: TriageRow["decision"]; decision_note: string; decided_by: string | null; decided_at: string | null; created_at: string } | null;
  return {
    installed: true,
    triage: r && { id: r.id, source: r.source, model: r.model, status: r.status, suggestion: r.suggestion, decision: r.decision, decisionNote: r.decision_note, decidedBy: r.decided_by, decidedAt: r.decided_at, createdAt: r.created_at },
  };
}

export interface MyJob {
  id: string; number: string; title: string; status: string; urgency: string; safetyCritical: boolean;
  scheduledFor: string | null; dueOn: string | null; unit: string; editSeq: number;
  myRole: "lead" | "assist"; myStatus: CrewMember["status"]; tasksDone: number; tasksTotal: number;
}
export interface OpenJob { id: string; number: string; title: string; status: string; urgency: string; safetyCritical: boolean; scheduledFor: string | null; unit: string }

/**
 * The mechanic's phone workspace (docs/COMPANION_APP.md): the open work orders the signed-in person is on (not yet
 * done with their part), their running timer, and open jobs nobody leads yet. Read as the person (RLS, maintenance.view).
 */
export async function listMyJobs(userId: string): Promise<{ installed: boolean; mine: MyJob[]; unled: OpenJob[]; myTimer: WorkOrderCrew["myTimer"] }> {
  const supabase = await createClient();
  const crew = await supabase.from("work_order_mechanics").select("work_order_id, role, status").eq("user_id", userId).neq("status", "done");
  if (crew.error && MISSING.has(crew.error.code ?? "")) return { installed: false, mine: [], unled: [], myTimer: null };
  const rows = (crew.data ?? []) as Array<{ work_order_id: string; role: "lead" | "assist"; status: CrewMember["status"] }>;
  const ids = rows.map((r) => r.work_order_id);
  const cols = "id, number, title, status, urgency, safety_critical, scheduled_for, due_on, edit_seq, truck_id, trailer_id";
  const [wos, tasks, unled, timer] = await Promise.all([
    ids.length ? supabase.from("work_orders").select(cols).in("id", ids).in("status", OPEN_STATUSES) : Promise.resolve({ data: [] }),
    ids.length ? supabase.from("work_order_tasks").select("work_order_id, status").in("work_order_id", ids) : Promise.resolve({ data: [] }),
    supabase.from("work_orders").select(cols).is("assigned_to", null).in("status", ["triaged", "scheduled", "in_progress", "awaiting_parts"]).order("created_at", { ascending: false }).limit(50),
    supabase.from("work_order_time_entries").select("work_order_id, started_at, work_orders(number)").eq("user_id", userId).is("ended_at", null).is("voided_at", null).maybeSingle(),
  ]);
  type Wo = { id: string; number: string; title: string; status: string; urgency: string; safety_critical: boolean; scheduled_for: string | null; due_on: string | null; edit_seq: number; truck_id: string | null; trailer_id?: string | null };
  const all = [...((wos.data ?? []) as Wo[]), ...((unled.data ?? []) as Wo[])];
  const truckIds = [...new Set(all.map((w) => w.truck_id).filter((x): x is string => Boolean(x)))];
  const trailerIds = [...new Set(all.map((w) => w.trailer_id).filter((x): x is string => Boolean(x)))];
  const [trucks, trailers] = await Promise.all([
    truckIds.length ? supabase.from("trucks").select("id, unit_number").in("id", truckIds) : Promise.resolve({ data: [] }),
    trailerIds.length ? supabase.from("trailers").select("id, unit_number").in("id", trailerIds) : Promise.resolve({ data: [] }),
  ]);
  const units = new Map<string, string>([
    ...((trucks.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => [t.id, `Truck ${t.unit_number}`] as [string, string]),
    ...((trailers.data ?? []) as Array<{ id: string; unit_number: string }>).map((t) => [t.id, `Trailer ${t.unit_number}`] as [string, string]),
  ]);
  const unit = (w: Wo) => units.get(w.truck_id ?? "") ?? units.get(w.trailer_id ?? "") ?? "No unit";
  const taskRows = (tasks.data ?? []) as Array<{ work_order_id: string; status: string }>;
  const rank = (w: { safetyCritical: boolean; urgency: string; status: string }) =>
    (w.status === "in_progress" ? 0 : 10) + (w.safetyCritical ? 0 : 5) + ({ immediate: 0, high: 1, normal: 2, low: 3 }[w.urgency] ?? 4);
  const mine = ((wos.data ?? []) as Wo[]).map((w) => {
    const me = rows.find((r) => r.work_order_id === w.id)!;
    const t = taskRows.filter((x) => x.work_order_id === w.id);
    return {
      id: w.id, number: w.number, title: w.title, status: w.status, urgency: w.urgency, safetyCritical: w.safety_critical,
      scheduledFor: w.scheduled_for, dueOn: w.due_on, unit: unit(w), editSeq: w.edit_seq, myRole: me.role, myStatus: me.status,
      tasksDone: t.filter((x) => x.status !== "open").length, tasksTotal: t.length,
    };
  }).sort((a, b) => rank(a) - rank(b) || a.number.localeCompare(b.number));
  const m = timer.data as { work_order_id: string; started_at: string; work_orders: { number: string } | null } | null;
  return {
    installed: true,
    mine,
    // Most urgent first (safety, then urgency), newest first within the same urgency; ten at most.
    unled: ((unled.data ?? []) as Wo[]).filter((w) => !ids.includes(w.id)).map((w) => ({
      id: w.id, number: w.number, title: w.title, status: w.status, urgency: w.urgency, safetyCritical: w.safety_critical, scheduledFor: w.scheduled_for, unit: unit(w),
    })).sort((a, b) => (rank(a) % 10) - (rank(b) % 10)).slice(0, 10),
    myTimer: m ? { workOrderId: m.work_order_id, number: m.work_orders?.number ?? "another work order", startedAt: m.started_at } : null,
  };
}
