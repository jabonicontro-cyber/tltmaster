import "server-only";
import { addDays } from "@/lib/dates";
import { createClient } from "@/server/supabase/server";

// Shift schedules (migration 20261120003300), read through the person's session: the company's schedules for people who
// plan or see staff, one's own for everyone else (RLS and public.schedule_range). Before the migration the loader says so.

export interface ScheduleDay {
  date: string;
  status: "shift" | "off" | "none";
  start: string | null; // "06:00"
  end: string | null;
  overnight: boolean;
  breakMinutes: number;
  source: "pattern" | "change" | null;
  reason: string;
}
export interface SchedulePerson { employeeId: string; name: string; department: string | null; days: ScheduleDay[] }

const MISSING = new Set(["42P01", "PGRST205", "42883", "PGRST202"]);

export async function getScheduleWeek(from: string, days = 7): Promise<{ installed: boolean; people: SchedulePerson[] }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("schedule_range", { p_from: from, p_days: days });
  if (error) {
    if (MISSING.has(error.code ?? "")) return { installed: false, people: [] };
    throw new Error(error.message);
  }
  const rows = (data ?? []) as Array<{ employee_id: string; full_name: string; department: string | null; work_date: string; status: ScheduleDay["status"]; start_time: string | null; end_time: string | null; overnight: boolean; break_minutes: number; source: ScheduleDay["source"]; reason: string }>;
  const people = new Map<string, SchedulePerson>();
  for (const r of rows) {
    const p = people.get(r.employee_id) ?? { employeeId: r.employee_id, name: r.full_name, department: r.department, days: [] };
    p.days.push({ date: r.work_date, status: r.status, start: r.start_time?.slice(0, 5) ?? null, end: r.end_time?.slice(0, 5) ?? null, overnight: r.overnight, breakMinutes: r.break_minutes, source: r.source, reason: r.reason ?? "" });
    people.set(r.employee_id, p);
  }
  return { installed: true, people: [...people.values()] };
}

/** The Monday of the week containing a date. */
export function weekStart(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

export interface CurrentPattern { kind: "weekly" | "rotation"; cycleDays: number; anchor: string; from: string; to: string | null; note: string; days: Array<{ day: number; start: string; end: string; breakMinutes: number }> }

/** Everyone's pattern in effect on a date, by employee, for the pattern editor. */
export async function listPatterns(on: string): Promise<Record<string, CurrentPattern>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("shift_patterns").select("employee_id, kind, cycle_days, anchor_date, effective_from, effective_to, note, shift_pattern_days(day_index, start_time, end_time, break_minutes)")
    .lte("effective_from", on).or(`effective_to.is.null,effective_to.gte.${on}`);
  if (error) return {};
  const out: Record<string, CurrentPattern> = {};
  for (const p of (data ?? []) as unknown as Array<{ employee_id: string; kind: "weekly" | "rotation"; cycle_days: number; anchor_date: string; effective_from: string; effective_to: string | null; note: string; shift_pattern_days: Array<{ day_index: number; start_time: string; end_time: string; break_minutes: number }> }>) {
    out[p.employee_id] = {
      kind: p.kind, cycleDays: p.cycle_days, anchor: p.anchor_date, from: p.effective_from, to: p.effective_to, note: p.note,
      days: p.shift_pattern_days.map((d) => ({ day: d.day_index, start: d.start_time.slice(0, 5), end: d.end_time.slice(0, 5), breakMinutes: d.break_minutes })).sort((a, b) => a.day - b.day),
    };
  }
  return out;
}
