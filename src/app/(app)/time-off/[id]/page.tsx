import Link from "next/link";
import { notFound } from "next/navigation";
import { TimeOffActions } from "@/components/time-off/time-off-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatTime } from "@/lib/orders/schedule";
import { can } from "@/lib/permissions";
import { calendarDays, STATUS_TONE, TIME_OFF_CATEGORIES, TIME_OFF_STATUSES } from "@/lib/time-off";
import { requireAccess } from "@/server/auth";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";
import { employeeNames, getTimeOff, myEmployee } from "@/server/data/time-off";

export const metadata = { title: "Time-off request" };

const EVENT_LABELS: Record<string, string> = { submitted: "Requested", updated: "Changed", approved: "Approved", denied: "Denied", canceled: "Canceled" };

export default async function TimeOffRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requireAccess();
  const { id } = await params;
  const detail = await getTimeOff(id).catch(() => null);
  if (!detail) notFound();
  const { request: r, events } = detail;
  const [people, names, me, { timezone, today }] = await Promise.all([getUserNames(), employeeNames(), myEmployee(access.userId), businessToday()]);
  const who = (u: string | null) => (u ? people[u] ?? "Former member" : "—");
  const own = me?.id === r.employee_id;
  const approver = can(access, "time_off.approve");
  const canDecide = approver && !own && r.status === "pending";
  const canCancel = r.status === "pending" ? own || approver : r.status === "approved" && (approver || (own && r.start_date > today));
  const approvedEvent = [...events].reverse().find((e) => e.kind === "approved");
  const conflicts = approvedEvent?.details.conflicting_assignments ?? [];

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Time off", href: "/time-off" }, { label: "Request" }]}
        title={`${names.get(r.employee_id)?.name ?? "Employee"} — ${TIME_OFF_CATEGORIES[r.category]}`}
        badges={<Badge tone={STATUS_TONE[r.status]}>{TIME_OFF_STATUSES[r.status]}</Badge>}
        actions={<TimeOffActions id={r.id} canDecide={canDecide} canCancel={canCancel} />}
      />
      {approver && own && r.status === "pending" && <p className="mb-4 text-sm text-muted">This is your own request: another approver must decide it.</p>}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Request" />
            <CardBody>
              <DescriptionList items={[
                { label: "Dates", value: r.full_day ? (r.start_date === r.end_date ? formatDate(r.start_date) : `${formatDate(r.start_date)} – ${formatDate(r.end_date)} (${calendarDays(r.start_date, r.end_date)} calendar days)`) : formatDate(r.start_date) },
                { label: "Time", value: r.full_day ? "Full day" : `${formatTime(r.start_time)}–${formatTime(r.end_time)} (${r.hours} hours)` },
                { label: "Category", value: TIME_OFF_CATEGORIES[r.category] },
                { label: "Comment", value: r.reason || "—", wide: true },
                ...(r.decided_at ? [{ label: "Decision", value: `${TIME_OFF_STATUSES[r.status === "canceled" ? "approved" : r.status]} by ${who(r.decided_by)}, ${formatDateTime(r.decided_at, timezone)}${r.decision_note ? ` — ${r.decision_note}` : ""}`, wide: true }] : []),
              ]} />
            </CardBody>
          </Card>
          {r.status === "approved" && conflicts.length > 0 && (
            <Card>
              <CardHeader title="Assignments to review" description="When this leave was approved, the driver was already booked at these times. Nothing was canceled automatically." />
              <ul className="divide-y divide-line text-sm">
                {conflicts.map((c) => (
                  <li key={c.assignment_id} className="px-4 py-2.5 sm:px-5">
                    <Link href={`/dispatch?date=${c.load_date}&load=${c.load_id}`} className="font-medium hover:underline">{c.order_number} load {c.load_number}</Link>
                    <span className="text-muted"> · {formatDate(c.load_date)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <Card className="self-start">
          <CardHeader title="History" />
          <ol className="divide-y divide-line text-sm">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-2.5 sm:px-5">
                <p className="font-medium">{EVENT_LABELS[e.kind] ?? e.kind}</p>
                {e.note && <p className="text-muted">{e.note}</p>}
                <p className="text-xs text-muted">{who(e.actor_id)} · {formatDateTime(e.created_at, timezone)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
