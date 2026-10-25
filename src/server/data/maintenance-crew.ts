import "server-only";
import { createClient } from "@/server/supabase/server";

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
