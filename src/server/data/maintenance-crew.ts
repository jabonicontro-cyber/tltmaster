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
