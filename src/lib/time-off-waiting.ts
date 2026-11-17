// Time off waiting for a decision by this person (walkthrough O1, owner 2026-11-14): pending requests never reached the
// Command Center or the briefing, so an owner only found them by opening Time off. Pure: which pending requests this
// person may decide, with the same rules as the request page (src/app/(app)/time-off/[id]/page.tsx) and the database
// (time_off_decide): nobody decides their own request, and with an approval chain only the role of the step the
// request waits for decides it.

export interface PendingTimeOff {
  id: string;
  employee_id: string;
  start_date: string;
  approval_step?: number | null;
}

export interface ApprovalStep {
  step_no: number;
  role: string;
}

export function timeOffWaitingFor<T extends PendingTimeOff>(
  pending: T[],
  me: { employeeId: string | null; role: string | null },
  chain: ApprovalStep[] | null,
): T[] {
  return pending
    .filter((r) => r.employee_id !== me.employeeId)
    .filter((r) => {
      if (!chain?.length) return true;
      const step = chain.find((c) => c.step_no === (r.approval_step ?? 1));
      return !step || step.role === me.role;
    })
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
}

/** "Time off waiting for you (2)" with the soonest request as the example; null when nothing waits. */
export function timeOffWaitingRow(waiting: Array<{ name: string; when: string }>): {
  kind: string; label: string; count: number; urgent: number; owner: string; example?: string; href: string;
} | null {
  if (!waiting.length) return null;
  return {
    kind: "time_off",
    label: `Time off waiting for you (${waiting.length})`,
    count: waiting.length,
    urgent: 0,
    owner: "You: approve or deny it",
    example: `${waiting[0].name}, ${waiting[0].when}`,
    href: "/time-off?status=pending",
  };
}
