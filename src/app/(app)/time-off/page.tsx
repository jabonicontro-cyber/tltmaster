import Link from "next/link";
import { CalendarOff } from "lucide-react";
import { TimeOffForm } from "@/components/time-off/time-off-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { formatTime } from "@/lib/orders/schedule";
import { can } from "@/lib/permissions";
import { calendarDays, STATUS_TONE, TIME_OFF_CATEGORIES, TIME_OFF_STATUSES } from "@/lib/time-off";
import { buttonClasses } from "@/components/ui/button";
import { formatHours } from "@/lib/pto";
import { requireAccess } from "@/server/auth";
import { balancesFor, listBanks } from "@/server/data/pto";
import { currentEmployees, employeeNames, listTimeOff, myEmployee, type TimeOffRow } from "@/server/data/time-off";
import { facesForEmployees, type Face } from "@/server/data/faces";
import { Avatar } from "@/components/ui/avatar";

export const metadata = { title: "Time off" };

type Search = { status?: string; employee?: string; q?: string };

function when(r: TimeOffRow) {
  if (!r.full_day) return `${formatDate(r.start_date)}, ${formatTime(r.start_time)}–${formatTime(r.end_time)} (${r.hours ?? "?"} h)`;
  const days = calendarDays(r.start_date, r.end_date);
  return r.start_date === r.end_date ? `${formatDate(r.start_date)} (full day)` : `${formatDate(r.start_date)} – ${formatDate(r.end_date)} (${days} calendar days)`;
}

function Requests({ rows, names, showEmployee, faces = {} }: { rows: TimeOffRow[]; names: Map<string, { name: string }>; showEmployee: boolean; faces?: Record<string, Face> }) {
  return (
    <TableWrap>
      <Table>
        <thead><tr>{showEmployee && <Th>Employee</Th>}<Th>When</Th><Th className="hidden sm:table-cell">Category</Th><Th>Status</Th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              {showEmployee && <Td className="font-medium"><span className="flex items-center gap-2.5"><Avatar name={names.get(r.employee_id)?.name ?? "Employee"} size={28} {...faces[r.employee_id]} />{names.get(r.employee_id)?.name ?? "Employee"}</span></Td>}
              <Td><Link href={`/time-off/${r.id}`} className="font-medium text-ink hover:underline">{when(r)}</Link></Td>
              <Td className="hidden sm:table-cell">{TIME_OFF_CATEGORIES[r.category]}</Td>
              <Td><Badge tone={STATUS_TONE[r.status]}>{TIME_OFF_STATUSES[r.status]}</Badge></Td>
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
  // Which bank each kind of time off draws from, for the request form (null = balances not installed yet).
  const bankFor: Record<string, { name: string; available: number | null }> = {};
  for (const b of (banks ?? []).filter((x) => x.active)) {
    const mine = myBalances.find((m) => m.bank_id === b.id);
    for (const c of b.categories) bankFor[c] = { name: b.name, available: mine ? mine.available : null };
  }

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
          <ul className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3" aria-label="My balances">
            {myBalances.map((b) => (
              <li key={b.bank_id} className="bg-card px-5 py-3 sm:px-6">
                <p className="text-sm font-semibold">{b.name}</p>
                <p className="mt-1 text-2xl font-semibold tabular" data-testid="available-hours">{formatHours(b.available)} <span className="text-sm font-normal text-muted">available</span></p>
                <p className="text-xs text-muted">Balance {formatHours(b.balance)}{b.pending ? ` · ${formatHours(b.pending)} pending` : ""}</p>
                {!b.eligible && <p className="mt-1 text-xs text-muted">Your employment type cannot use this bank.</p>}
                {b.usable_from && <p className="mt-1 text-xs text-muted">Usable from {formatDate(b.usable_from)}.</p>}
                {b.hire_date_missing && <p className="mt-1 text-xs text-muted">No hire date is recorded, so the waiting period cannot be checked — ask the office.</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title={canApprove ? "Request or enter time off" : "Request time off"} />
          <CardBody>
            {me || canApprove ? <TimeOffForm employees={employees} ownEmployeeId={me?.id ?? null} bankFor={bankFor} /> : (
              <p className="text-sm text-muted">Your login is not linked to an employee record, so you cannot request time off here yet. Ask the office to link it in Employees.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="My requests" />
          {!me || mine.length === 0 ? <EmptyState icon={<CalendarOff className="size-6" />} title="No requests yet" /> : <Requests rows={mine} names={names} showEmployee={false} />}
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
