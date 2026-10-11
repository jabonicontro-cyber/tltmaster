import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { fmtNum, PmStateBadge } from "@/components/maintenance/bits";
import { ReadingForm, ScheduleForm } from "@/components/maintenance/pm-forms";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { GenerateDueButton } from "@/components/maintenance/work-order-actions";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { PM_STATES, type PmState } from "@/lib/maintenance";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listPmStatus, listTrucks, type PmRow } from "@/server/data/maintenance";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Preventive maintenance" };

type Search = { state?: string; truck?: string; q?: string };

const ORDER: Record<PmState, number> = { overdue: 0, due_soon: 1, unknown: 2, ok: 3 };

/** One line per trigger: what is due next, or exactly which data is missing. */
function triggers(p: PmRow, timezone: string) {
  const out: Array<{ label: string; state: PmState | null }> = [];
  if (p.interval_days !== null) {
    out.push({
      state: p.days_state,
      label: p.next_due_on ? `Every ${p.interval_days} days · next ${formatDate(p.next_due_on)}` : `Every ${p.interval_days} days · last service date missing`,
    });
  }
  if (p.interval_miles !== null) {
    const reading = p.current_miles !== null ? `now ${fmtNum(p.current_miles)} mi (read ${formatDateTime(p.miles_read_at, timezone)})` : "no odometer reading";
    out.push({
      state: p.miles_state,
      label: p.next_due_miles !== null ? `Every ${fmtNum(p.interval_miles)} mi · next at ${fmtNum(p.next_due_miles)} mi · ${reading}` : `Every ${fmtNum(p.interval_miles)} mi · odometer at last service missing · ${reading}`,
    });
  }
  if (p.interval_hours !== null) {
    const reading = p.current_hours !== null ? `now ${fmtNum(p.current_hours)} h (read ${formatDateTime(p.hours_read_at, timezone)})` : "no engine-hour reading";
    out.push({
      state: p.hours_state,
      label: p.next_due_hours !== null ? `Every ${fmtNum(p.interval_hours)} h · next at ${fmtNum(p.next_due_hours)} h · ${reading}` : `Every ${fmtNum(p.interval_hours)} h · engine hours at last service missing · ${reading}`,
    });
  }
  return out;
}

export default async function PreventivePage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("maintenance.view");
  const sp = await searchParams;
  const [all, trucks, { timezone }] = await Promise.all([listPmStatus(), listTrucks(), businessToday()]);
  const active = trucks.filter((t) => t.active);
  const q = (sp.q ?? "").trim().toLowerCase();
  const rows = all
    .filter((p) => !sp.state || (sp.state === "unknown" ? p.state === "unknown" || p.readings_stale : p.state === sp.state))
    .filter((p) => !sp.truck || p.truck_id === sp.truck)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.unit_number.toLowerCase().includes(q))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.unit_number.localeCompare(b.unit_number));
  const manage = can(access, "maintenance.manage");

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Maintenance", href: "/maintenance" }, { label: "Preventive" }]}
        title="Preventive maintenance"
        description="Services by calendar days, miles and/or engine hours — whichever comes first. Missing or old readings are shown, never assumed."
        actions={manage && <GenerateDueButton />}
      />
      <MaintenanceTabs active="preventive" />
      <Card>
        <FilterBar action="/maintenance/preventive" query={sp.q} placeholder="Search service or truck…" clearHref="/maintenance/preventive">
          <FilterSelect name="state" label="State" value={sp.state ?? ""} options={[{ value: "", label: "Any state" }, ...Object.entries(PM_STATES).map(([value, label]) => ({ value, label: value === "unknown" ? "Needs data (missing or stale)" : label }))]} />
          <FilterSelect name="truck" label="Truck" value={sp.truck ?? ""} options={[{ value: "", label: "Any truck" }, ...active.map((t) => ({ value: t.id, label: t.unit_number }))]} />
        </FilterBar>
        {rows.length === 0 ? (
          <EmptyState
            icon={<CalendarCheck className="size-6" />}
            title={all.length ? "No schedules match these filters" : "No preventive schedules yet"}
            description={all.length ? "Try a different filter." : "Add a schedule per truck and service below."}
          />
        ) : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Truck</Th><Th>Service</Th><Th>Next due</Th><Th>State</Th><Th className="hidden md:table-cell">Work order</Th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <Tr key={p.schedule_id}>
                    <Td className="font-semibold whitespace-nowrap tabular">{p.unit_number}</Td>
                    <Td>{p.name}</Td>
                    <Td className="text-sm">
                      <ul className="space-y-0.5">
                        {triggers(p, timezone).map((t) => (
                          <li key={t.label} className={t.state === "overdue" ? "font-medium text-critical" : t.state === "unknown" ? "text-muted italic" : undefined}>{t.label}</li>
                        ))}
                      </ul>
                      {p.readings_stale && <div className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">Reading older than 30 days — record a new one.</div>}
                    </Td>
                    <Td><PmStateBadge state={p.state} /></Td>
                    <Td className="hidden md:table-cell">
                      {p.open_work_order_id
                        ? <Link href={`/maintenance/work-orders/${p.open_work_order_id}`} className="font-medium whitespace-nowrap underline">{p.open_work_order_number}</Link>
                        : <span className="text-muted">—</span>}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {manage && active.length > 0 && (
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader title="Record a reading" description="Odometer and engine hours. A value lower than the last reading is refused." />
            <CardBody><ReadingForm trucks={active} /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Add a schedule" description="Enter at least one interval. Due work orders are created when you choose “Create work orders for due services” — never twice for the same service." />
            <CardBody><ScheduleForm trucks={active} defaultTruck={sp.truck} /></CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
