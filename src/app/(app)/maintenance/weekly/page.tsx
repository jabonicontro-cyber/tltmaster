import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { PrintButton } from "@/components/quotes/print-button";
import { Button, ButtonLink } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { addDays, formatDate, isOperationalDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { hoursText, weekOf, type WeekWorkOrder } from "@/lib/maintenance/shop-week";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { loadShopWeek } from "@/server/data/shop-week";

export const metadata = { title: "Weekly shop report" };

/**
 * The weekly shop report (2026-11-09): work orders opened, completed and closed, labor hours, parts cost, days out of
 * service per truck and preventive service done against due, for a chosen week. Read-only and printable (force-light);
 * every number comes from records already kept. What is not recorded is said so, never shown as zero.
 */
export default async function WeeklyShopReport({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const access = await requirePagePermission("maintenance.view");
  const sp = await searchParams;
  const { today, timezone } = await businessToday();
  const { start, end } = weekOf(sp.week && isOperationalDate(sp.week) ? sp.week : today);
  const canCosts = can(access, "maintenance.costs");
  const r = await loadShopWeek(start, end, timezone, canCosts);
  const lastDay = addDays(end, -1);
  const current = start <= today && today < end;
  const unit = (w: WeekWorkOrder) => (w.trailer_id ? r.units.get(w.trailer_id) : w.truck_id ? r.units.get(w.truck_id) : null) ?? "–";
  const company = access.companyName ?? "";

  return (
    <>
      <PageHeader
        title="Weekly shop report"
        description="What the shop did in one week, from the records already kept. Nothing here changes anything."
        actions={<div className="print:hidden"><PrintButton /></div>}
      />
      <div className="print:hidden"><MaintenanceTabs active="weekly" /></div>
      <form method="get" className="mb-5 flex flex-wrap items-end gap-2 print:hidden" aria-label="Choose the week">
        <ButtonLink href={`/maintenance/weekly?week=${addDays(start, -7)}`} variant="secondary" className="min-h-12 sm:min-h-0" icon={<ChevronLeft className="size-4" />}>Week before</ButtonLink>
        <label className="space-y-1.5 text-sm font-medium text-ink">
          <span className="block">Any day in the week</span>
          <DateInput name="week" defaultValue={start} className="min-h-12 sm:min-h-0" />
        </label>
        <Button type="submit" variant="secondary" className="min-h-12 sm:min-h-0">Show week</Button>
        {!current && <ButtonLink href={`/maintenance/weekly?week=${addDays(start, 7)}`} variant="secondary" className="min-h-12 sm:min-h-0" icon={<ChevronRight className="size-4" />}>Week after</ButtonLink>}
      </form>

      <article className="force-light rounded-panel border border-line/70 bg-card p-6 text-ink shadow-card print:border-0 print:p-0 print:shadow-none" aria-label="Weekly shop report">
        <header className="border-b border-line pb-4">
          {company && <p className="text-sm text-muted">{company}</p>}
          <h2 className="text-xl font-semibold">Shop week of {formatDate(start)} to {formatDate(lastDay)}</h2>
          {current && <p className="text-sm text-muted">This week is not over yet: the numbers run to now.</p>}
        </header>

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-label="Week totals">
          {[
            ["Opened", String(r.opened.length)],
            ["Completed", String(r.completed.length)],
            ["Closed", String(r.closed.length)],
            ["Labor recorded", r.laborMinutes === null ? "Not recorded" : r.laborMinutes === 0 ? "None recorded" : hoursText(r.laborMinutes)],
            ["Parts cost", r.partsCents === null ? "Cost access needed" : formatCents(r.partsCents)],
            ["Preventive done / due", `${r.pmDone.length} / ${r.pmDone.length + r.pmDue.length}`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-surface px-4 py-3">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular">{value}</dd>
            </div>
          ))}
        </dl>
        {r.runningTimers > 0 && <p className="mt-2 text-sm text-muted">{r.runningTimers} timer{r.runningTimers === 1 ? " is" : "s are"} still running and not counted in the labor.</p>}
        {r.partsCents !== null && <p className="mt-2 text-sm text-muted">Parts cost: part cost lines added to jobs this week, less parts returned to stock. Parts used without a known cost add nothing.</p>}

        <Section title="Days out of service per truck" empty="No truck was out of service this week." count={r.outOfService.length}>
          <TableWrap className="rounded-none border-0">
            <Table aria-label="Days out of service per truck">
              <thead><tr><Th>Truck</Th><Th align="right">Days out of service</Th></tr></thead>
              <tbody>{r.outOfService.map((t) => <Tr key={t.truck_id}><Td><Link href={`/fleet/trucks/${t.truck_id}`} className="font-medium hover:underline">Truck {t.unit_number}</Link></Td><Td className="text-right tabular">{t.days}</Td></Tr>)}</tbody>
            </Table>
          </TableWrap>
          <p className="mt-2 text-xs text-muted">From recorded service status changes; a truck taken out of service before its history was kept counts from when it was recorded.</p>
        </Section>

        <Section title="Preventive service" empty="Nothing preventive was done or due this week." count={r.pmDone.length + r.pmDue.length}>
          <ul className="divide-y divide-line text-sm">
            {r.pmDone.map((w) => <li key={w.id} className="flex flex-wrap gap-x-3 py-2"><span className="font-medium text-ink">Done</span><Link href={`/maintenance/work-orders/${w.id}`} className="hover:underline">{w.number} · {w.title}</Link><span className="text-muted">{unit(w)}</span></li>)}
            {r.pmDue.map((p) => (
              <li key={p.schedule_id} className="flex flex-wrap gap-x-3 py-2">
                <span className={p.state === "overdue" ? "font-medium text-critical" : "font-medium text-ink"}>{p.state === "overdue" ? "Overdue" : "Due"}</span>
                <span>{p.name}</span>
                <span className="text-muted">Truck {p.unit_number}{p.next_due_on ? `, due ${formatDate(p.next_due_on)}` : ""}{p.open_work_order_number ? `, work order ${p.open_work_order_number} open` : ""}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Due: services due by the end of the week (by date, miles or engine hours) and still not done today.</p>
        </Section>

        <WorkOrderList title="Opened" rows={r.opened} unit={unit} empty="No work orders were opened this week." />
        <WorkOrderList title="Completed" rows={r.completed} unit={unit} empty="No work orders were completed this week." />
        <WorkOrderList title="Closed" rows={r.closed} unit={unit} empty="No work orders were closed this week." />
      </article>
    </>
  );
}

function Section({ title, empty, count, children }: { title: string; empty: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mt-6 break-inside-avoid" aria-label={title}>
      <h3 className="mb-2 text-base font-semibold">{title}</h3>
      {count === 0 ? <p className="text-sm text-muted">{empty}</p> : children}
    </section>
  );
}

function WorkOrderList({ title, rows, unit, empty }: { title: string; rows: WeekWorkOrder[]; unit: (w: WeekWorkOrder) => string; empty: string }) {
  return (
    <Section title={`${title} (${rows.length})`} empty={empty} count={rows.length}>
      <ul className="divide-y divide-line text-sm">
        {rows.map((w) => (
          <li key={w.id} className="flex flex-wrap gap-x-3 py-2">
            <Link href={`/maintenance/work-orders/${w.id}`} className="font-medium tabular hover:underline">{w.number}</Link>
            <span className="min-w-0 flex-1">{w.title}</span>
            <span className="text-muted">{unit(w)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
