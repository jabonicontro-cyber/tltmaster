import "server-only";
import { formatDate } from "@/lib/dates";
import { can, type Access } from "@/lib/permissions";
import { timeOffWaitingFor } from "@/lib/time-off-waiting";
import { approvalChain, employeeNames, myEmployee } from "@/server/data/time-off";
import { createClient } from "@/server/supabase/server";

/**
 * Pending time off this person may decide (O1), for the Command Center and the briefing. Only for people with
 * time_off.approve; read with their own session (RLS: their company's requests, time_off.view). null when they cannot
 * approve, the time-off tables are not installed or the requests cannot be read: nothing is shown rather than a zero.
 */
export async function timeOffWaitingForMe(access: Access): Promise<Array<{ id: string; name: string; when: string }> | null> {
  if (!can(access, "time_off.approve")) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("time_off_requests")
    .select("id, employee_id, start_date, end_date, approval_step")
    .eq("status", "pending")
    .order("start_date")
    .limit(200);
  if (error) return null;
  const [me, chain, names] = await Promise.all([myEmployee(access.userId), approvalChain(), employeeNames()]);
  const rows = (data ?? []) as Array<{ id: string; employee_id: string; start_date: string; end_date: string; approval_step: number | null }>;
  return timeOffWaitingFor(rows, { employeeId: me?.id ?? null, role: access.role ?? null }, chain).map((r) => ({
    id: r.id,
    name: names.get(r.employee_id)?.name ?? "An employee",
    when: r.start_date === r.end_date ? formatDate(r.start_date) : `${formatDate(r.start_date)} – ${formatDate(r.end_date)}`,
  }));
}
