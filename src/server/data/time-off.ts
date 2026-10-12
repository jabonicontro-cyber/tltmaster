import "server-only";
import { createClient } from "@/server/supabase/server";
import type { TimeOffCategory, TimeOffStatus } from "@/lib/time-off";

export interface TimeOffRow {
  id: string;
  employee_id: string;
  category: TimeOffCategory;
  start_date: string;
  end_date: string;
  full_day: boolean;
  start_time: string | null;
  end_time: string | null;
  hours: number | null;
  reason: string;
  status: TimeOffStatus;
  submitted_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string;
  edit_seq: number;
  created_at: string;
}

/** null = the time-off tables are not installed yet (migration pending). */
export async function listTimeOff(f: { status?: string; employee?: string; own?: string | null }): Promise<TimeOffRow[] | null> {
  const supabase = await createClient();
  let q = supabase.from("time_off_requests").select("*").order("start_date", { ascending: false }).limit(300);
  if (f.status && f.status !== "all") q = q.eq("status", f.status);
  if (f.employee) q = q.eq("employee_id", f.employee);
  if (f.own) q = q.eq("employee_id", f.own);
  const { data, error } = await q;
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return null;
    throw new Error(`Could not load time off: ${error.message}`);
  }
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({ ...(r as unknown as TimeOffRow), hours: r.hours === null ? null : Number(r.hours) }));
}

export async function getTimeOff(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("time_off_requests").select("*").eq("id", id).maybeSingle();
  if (error) {
    if (error.code === "22P02") return null;
    throw new Error(`Could not load the request: ${error.message}`);
  }
  if (!data) return null;
  const events = await supabase.from("time_off_events").select("id, kind, note, details, actor_id, created_at").eq("request_id", id).order("created_at");
  return {
    request: { ...(data as unknown as TimeOffRow), hours: (data as { hours: unknown }).hours === null ? null : Number((data as { hours: unknown }).hours) },
    events: (events.data ?? []) as Array<{ id: string; kind: string; note: string; details: { conflicting_assignments?: Array<{ assignment_id: string; load_id: string; order_number: string; load_number: number; load_date: string }>; was?: string }; actor_id: string | null; created_at: string }>,
  };
}

/** The caller's own employee record, if their login is linked to one. */
export async function myEmployee(userId: string): Promise<{ id: string; full_name: string } | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("employees").select("id, full_name").eq("user_id", userId).maybeSingle();
  return (data ?? null) as { id: string; full_name: string } | null;
}

/** Names of employees the caller may see (employees.view), or just their own. */
export async function employeeNames(): Promise<Map<string, { name: string; driver: boolean }>> {
  const supabase = await createClient();
  const { data } = await supabase.from("employees").select("id, full_name, driver_id, status").order("full_name");
  return new Map(((data ?? []) as Array<{ id: string; full_name: string; driver_id: string | null }>).map((e) => [e.id, { name: e.full_name, driver: Boolean(e.driver_id) }]));
}

export async function currentEmployees(): Promise<Array<{ id: string; full_name: string }>> {
  const supabase = await createClient();
  const { data } = await supabase.from("employees").select("id, full_name").in("status", ["active", "on_leave"]).order("full_name");
  return (data ?? []) as Array<{ id: string; full_name: string }>;
}
