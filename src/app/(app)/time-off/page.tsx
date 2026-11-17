import Link from "next/link";
import { CalendarOff } from "lucide-react";
import { TimeOffForm } from "@/components/time-off/time-off-form";
import { CancelRequestButton } from "@/components/time-off/time-off-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { formatTime } from "@/lib/orders/schedule";
import { can, ROLE_LABELS, type AppRole } from "@/lib/permissions";
import { calendarDays, STATUS_TONE, TIME_OFF_CATEGORIES, TIME_OFF_STATUSES, type WeekHours } from "@/lib/time-off";
import { buttonClasses } from "@/components/ui/button";
import { formatHours } from "@/lib/pto";
import { requireAccess } from "@/server/auth";
import { balancesFor, listBanks } from "@/server/data/pto";
import { approvalChain, currentEmployees, employeeNames, listTimeOff, myEmployee, type TimeOffRow } from "@/server/data/time-off";
import { facesForEmployees, type Face } from "@/server/data/faces";
import { Avatar } from "@/components/ui/avatar";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Time off" };

type Search = { status?: string; employee?: string; q?: string };

function when(r: TimeOffRow) {
  if (!r.full_day) return `${formatDate(r.start_date)}, ${formatTime(r.start_time)}–${formatTime(r.end_time)} (${r.hours ?? "?"} h)`;
  const days = calendarDays(r.start_date, r.end_date);
  return r.start_date === r.end_date ? `${formatDate(r.start_date)} (full day)` : `${formatDate(r.start_date)} – ${formatDate(r.end_date)} (${days} calendar days)`;
}

function Requests({ rows, names, showEmployee, faces = {}, cancelable = false, waitingFor }: { rows: TimeOffRow[]; names: Map<string, { name: string }>; showEmployee: boolean; faces?: Record<string, Face>; /** Own requests: a Cancel button on each pending one. */ cancelable?: boolean; /** Who decides a pending request (O2). */ waitingFor?: (r: TimeOffRow) => string | null }) {
  return (
    <TableWrap>
      <Table>
        <thead><tr>{showEmployee && <Th>Employee</Th>}<Th>When</Th><Th className="hidden sm:table-cell">Category</Th><Th>Status</Th>{cancelable && <Th><span className="sr-only">Actions</span></Th>}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              {showEmployee && <Td className="font-medium"><span className="flex items-center gap-2.5"><Avatar name={names.get(r.employee_id)?.name ?? "Employee"} size={28} {...faces[r.employee_id]} />{names.get(r.employee_id)?.name ?? "Employee"}</span></Td>}
              <Td><Link href={`/time-off/${r.id}`} className="font-medium text-ink hover:underline">{when(r)}</Link></Td>
              <Td className="hidden sm:table-cell">{TIME_OFF_CATEGORIES[r.category]}</Td>
              <Td>
                <Badge tone={STATUS_TONE[r.status]}>{TIME_OFF_STATUSES[r.status]}</Badge>
                {r.status === "pending" && waitingFor?.(r) && <span className="mt-1 block text-xs text-muted">{waitingFor(r)}</span>}
              </Td>
              {cancelable && <Td className="text-right">{r.status === "pending" ? <CancelRequestButton id={r.id} /> : null}</Td>}
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}

export default async function TimeOffPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requireAccess();
  const sp = await searchParams;
  const me = await myEmployee(access.userId);
  const canView = can(access, "time_off.view");
  const canApprove = can(access, "time_off.approve");
  // Also tells whether the time-off tables exist (null = database update not installed).
  const mine = await listTimeOff({ own: me?.id ?? "00000000-0000-0000-0000-000000000000", status: "all" });
  if (mine === null) {
    return (
      <>
        <PageHeader title="Time off" />
        <Notice tone="warning" title="Not available yet">Time-off requests need a database update that has not been installed yet.</Notice>
      </>
    );
  }
  const status = sp.status ?? "pending";
  const canBalances = can(access, "time_off.balances");
  const [all, names, employees, banks, myBalances] = await Promise.all([
    canView ? listTimeOff({ status, employee: sp.employee }) : Promise.resolve([] as TimeOffRow[]),
    employeeNames(),
    canApprove ? currentEmployees() : Promise.resolve(null),
    listBanks(),
    me ? balancesFor() : Promise.resolve([]),
  ]);
  // The person's own work schedule: their full-day requests use its hours (the form says so and shows the total).
  // Readable by the employee themself; null without one or before work schedules are installed.
  const mySchedule = me
    ? await (await createClient()).from("employee_work_schedules").select("mon_hours, tue_hours, wed_hours, thu_hours, fri_hours, sat_hours, sun_hours").eq("employee_id", me.id).maybeSingle().then((r) => (r.error ? null : (r.data as WeekHours | null)), () => null)
    : null;
  // Which bank each kind of time off draws from, for the request form (null = balances not installed yet).
  const bankFor: Record<string, { name: string; available: number | null }> = {};
  for (const b of (banks ?? []).filter((x) => x.active)) {
    const mine = myBalances.find((m) => m.bank_id === b.id);
    for (const c of b.categories) bankFor[c] = { name: b.name, available: mine ? mine.available : null };
  }

  // Who decides a pending request (O2: the approver was never named). Roles, not names: everyone may read which roles
  // approve time off (role_permissions), while the list of members is for people who manage users. With an approval
  // chain, the role of the step the request waits for decides it.
  const supabase = await createClient();
  const [approverRoles, chain] = await Promise.all([
    supabase.from("role_permissions").select("role").eq("permission", "time_off.approve").then((r) => (r.error ? [] : [...new Set((r.data ?? []).map((x) => String(x.role)))]), () => [] as string[]),
    approvalChain().catch(() => null),
  ]);
  const roleWords = (roles: string[]) => {
    const labels = roles.map((r) => ROLE_LABELS[r as AppRole] ?? r);
    return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
  };
  const waitingFor = (r: TimeOffRow) => {
    const step = chain?.length ? chain.find((c) => c.step_no === (r.approval_step ?? 1)) : null;
    const roles = step ? [step.role] : approverRoles;
    return roles.length ? `Waiting for ${step && chain ? `step ${step.step_no} of ${chain.length}, ` : ""}${roleWords(roles)} to decide` : null;
  };
  // An approver's own request needs another approver (nobody decides their own). Someone who manages users can see
  // whether anyone else holds an approving role; when nobody does, the request would wait for ever, so say so.
  const ownPending = mine.some((r) => r.status === "pending");
  const otherApprovers = canApprove && ownPending && can(access, "users.manage") && approverRoles.length
    ? await supabase.from("company_memberships").select("user_id", { count: "exact", head: true }).eq("active", true).in("role", approverRoles).neq("user_id", access.userId)
        .then((r) => (r.error ? null : r.count ?? 0), () => null)
    : null;

  const q = (sp.q ?? "").trim().toLowerCase();
  const shown = (all ?? []).filter((r) => !q || (names.get(r.employee_id)?.name ?? "").toLowerCase().includes(q));

  return (
    <>
      <PageHeader
        title="Time off"
        description="Request time off and follow your requests. Approved leave makes a driver unavailable to dispatch for those dates and hours."
        actions={canBalances && banks !== null ? <Link href="/time-off/balances" className={buttonClasses("secondary", "md")}>Banks and balances</Link> : undefined}
      />
      {banks === null ? (
        <Notice title="Coming soon">Time-off balances. Until they are installed, requests are not checked against a balance.</Notice>
      ) : banks.every((b) => !b.active) ? (
        <Notice title="No balances are tracked">
          No time-off bank is set up, so requests are not checked against a balance.{canBalances ? <> Set one up in <Link href="/time-off/balances" className="underline">Banks and balances</Link>.</> : null}
        </Notice>
      ) : null}
      {myBalances.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="My balances" description="Available = balance minus your pending requests." />
          <ul className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2 lg:grid-cols-3" aria-label="My balances">
            {myBalances.map((b) => (
              <li key={b.bank_id} className="bg-card px-5 py-3 sm:px-6">
                <p className="text-sm font-semibold">{b.name}</p>
                <p className="mt-1 text-[1.875rem] leading-tight font-semibold tracking-[-0.03em] tabular" data-testid="available-hours">{formatHours(b.available)} <span className="text-sm font-normal text-muted">available</span></p>
                <p className="text-xs text-muted">Balance {formatHours(b.balance)}{b.pending ? ` · ${formatHours(b.pending)} pending` : ""}</p>
                {!b.eligible && <p className="mt-1 text-xs text-muted">Your employment type cannot use this bank.</p>}
                {b.usable_from && <p className="mt-1 text-xs text-muted">Usable from {formatDate(b.usable_from)}.</p>}
                {b.hire_date_missing && <p className="mt-1 text-xs text-muted">No hire date is recorded, so the waiting period cannot be checked. Ask the office.</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title={canApprove ? "Request or enter time off" : "Request time off"} />
          <CardBody>
            {canApprove && !me && (
              // O2: an owner without a People record hit "Ask the office to link it" with an empty list. Say what to do.
              <div className="mb-4" data-testid="time-off-not-linked">
                <Notice title="Your sign-in is not linked to a person in People">
                  {can(access, "employees.view")
                    ? <>To request time off for yourself, add yourself in <Link href="/employees" className="font-semibold underline">People</Link>, open your person and choose your sign-in under Link an existing login. You can still enter time off for anyone already in People.</>
                    : "To request time off for yourself, ask someone who manages people to link your sign-in to your person in People. You can still enter time off for anyone already in People."}
                </Notice>
              </div>
            )}
            {canApprove && !me && employees?.length === 0 ? (
              <EmptyState
                icon={<CalendarOff className="size-6" />}
                title="Nobody is in People yet"
                description="Time off is recorded for a person in People. Add your team (and yourself) first."
                action={can(access, "employees.view") ? <Link href="/employees/new" className={buttonClasses("primary", "md")}>Add a person</Link> : undefined}
              />
            ) : me || canApprove ? <TimeOffForm employees={employees} ownEmployeeId={me?.id ?? null} bankFor={bankFor} schedule={mySchedule} /> : (
              <p className="text-sm text-muted">Your sign-in is not linked to a person in People, so you cannot request time off here yet. Ask whoever manages people at your company to link it.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="My requests" />
          {otherApprovers === 0 && (
            <p className="border-b border-line px-5 py-3 text-sm text-amber-900 sm:px-6" role="status" data-testid="no-other-approver">
              Nobody else can approve your request: nobody decides their own time off, and no one else has a role that approves it. Give another role time-off approval in Settings → Roles and permissions, or add a person with such a role.
            </p>
          )}
          {!me || mine.length === 0 ? <EmptyState icon={<CalendarOff className="size-6" />} title="No requests yet" /> : <Requests rows={mine} names={names} showEmployee={false} cancelable waitingFor={waitingFor} />}
        </Card>
      </div>

      {canView && (
        <Card className="mt-5">
          <CardHeader title="Everyone's requests" description={canApprove ? "Open a request to approve or deny it. Nobody can decide their own request." : "You can see requests; deciding them needs the time-off approval permission."} />
          <FilterBar action="/time-off" clearHref="/time-off" placeholder="Search employee name…" query={sp.q}>
            <FilterSelect name="status" label="Status" value={status} options={[...Object.entries(TIME_OFF_STATUSES).map(([value, label]) => ({ value, label })), { value: "all", label: "All" }]} />
            <FilterSelect name="employee" label="Employee" value={sp.employee ?? ""} options={[{ value: "", label: "Everyone" }, ...[...names.entries()].map(([value, e]) => ({ value, label: e.name }))]} />
          </FilterBar>
          {shown.length === 0 ? <EmptyState title="No requests match" /> : <Requests rows={shown} names={names} showEmployee faces={await facesForEmployees(shown.map((r) => r.employee_id))} />}
        </Card>
      )}
    </>
  );
}
