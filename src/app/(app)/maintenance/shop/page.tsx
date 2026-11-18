import Link from "next/link";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { ShopSettingsForm, SkillsRow } from "@/components/maintenance/shop-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate } from "@/lib/dates";
import { WO_CATEGORIES } from "@/lib/maintenance";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getShopCapacity, listMechanicSkills } from "@/server/data/maintenance-crew";
import { listAssignees, listOpenWorkOrders } from "@/server/data/maintenance";
import { partWaits } from "@/server/data/parts";
import { addDays } from "@/lib/dates";
import { partArrivalConflicts } from "@/lib/maintenance/part-arrival";
import { PartArrivalWarning } from "@/components/maintenance/part-arrival-warning";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Shop capacity" };

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Nov 21": short enough for a day's badge. */
const shortDay = (d: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${d}T00:00:00Z`));

export default async function ShopCapacityPage() {
  const access = await requirePagePermission("maintenance.view");
  const manage = can(access, "maintenance.manage");
  const { today } = await businessToday();
  const [capacity, skills, mechanics, open, onOrder] = await Promise.all([getShopCapacity(today, 14), listMechanicSkills(), listAssignees(),
    listOpenWorkOrders().catch(() => []), partWaits().catch(() => ({ installed: false, rows: [] }))]);
  // Jobs in the next 14 days scheduled before a part they wait for is expected (WK3): flagged on their day, with a move
  // offer above the table. Nothing is moved unless a person presses it.
  const end = addDays(today, 14);
  const inRange = open.filter((w) => w.scheduled_for && w.scheduled_for >= today && w.scheduled_for < end);
  const arrivals = partArrivalConflicts(inRange, onOrder.rows, today);
  const arrivalJobs = inRange.filter((w) => arrivals.has(w.id)).sort((a, b) => (a.scheduled_for ?? "").localeCompare(b.scheduled_for ?? ""));

  return (
    <>
      <PageHeader title="Maintenance" description="Shop capacity: mechanic-hours available each day against the estimated work scheduled and the bays it needs. For planning only; nothing is moved or assigned unless you choose to." />
      <MaintenanceTabs active="shop" />
      {arrivalJobs.length > 0 && (
        <Card className="mb-5">
          <CardHeader title="Scheduled before their parts arrive" description={manage ? "Move a job to the day its part is expected, or keep the date if the part will be in sooner." : "Ask whoever plans the shop to move these jobs or confirm the parts."} />
          <ul className="divide-y divide-line" aria-label="Scheduled before their parts arrive">
            {arrivalJobs.map((w) => (
              <li key={w.id} className="space-y-1 px-5 py-3 sm:px-6">
                <Link href={`/maintenance/work-orders/${w.id}`} className="font-medium text-ink hover:underline">{w.number} · {w.title}</Link>
                <PartArrivalWarning conflict={arrivals.get(w.id)!} canMove={manage} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!capacity.installed ? (
        <Notice tone="info" title="Not available yet">Shop capacity needs a database update that has not been installed yet.</Notice>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <Card>
            <CardHeader title="Next 14 days" description={capacity.configured
              ? "Available hours are each mechanic's shift minus approved time off. Planned hours add up the estimates of scheduled work orders."
              : "Set up the shop (bays, shift and working days) to see capacity."} />
            {capacity.configured ? (
              <TableWrap>
                <Table>
                  <thead><tr><Th>Day</Th><Th className="text-right">Mechanics</Th><Th>Hours planned / available</Th><Th className="text-right">Jobs / bays</Th><Th>Needs attention</Th></tr></thead>
                  <tbody>
                    {capacity.days.map((d) => {
                      const over = d.planned_hours > d.available_hours;
                      const pct = d.available_hours > 0 ? Math.min(100, Math.round((d.planned_hours / d.available_hours) * 100)) : d.planned_hours > 0 ? 100 : 0;
                      const dayArrivals = arrivalJobs.filter((w) => w.scheduled_for === d.date);
                      const notes = [
                        !d.working_day && d.jobs > 0 ? "Work scheduled on a closed day" : null,
                        over ? `${(d.planned_hours - d.available_hours).toFixed(1)} h over` : null,
                        d.jobs > d.bays ? `${d.jobs - d.bays} more job${d.jobs - d.bays === 1 ? "" : "s"} than bays` : null,
                        d.unestimated > 0 ? `${d.unestimated} without an estimate` : null,
                      ].filter(Boolean) as string[];
                      return (
                        <Tr key={d.date} className={d.working_day ? undefined : "bg-surface"}>
                          <Td className="whitespace-nowrap font-medium">{WEEKDAY[new Date(`${d.date}T12:00:00Z`).getUTCDay()]} {formatDate(d.date)}{!d.working_day && <span className="ml-1 text-xs text-muted">closed</span>}</Td>
                          <Td className="text-right tabular">{d.working_day ? d.mechanics : "–"}</Td>
                          <Td>
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-surface" aria-hidden>
                                <div className={`h-full ${over ? "bg-critical" : "bg-strong"}`} style={{ width: `${pct}%` }} />
                              </div>
                              <span className="tabular whitespace-nowrap text-sm">{d.planned_hours} / {d.available_hours} h</span>
                            </div>
                          </Td>
                          <Td className="text-right tabular">{d.jobs} / {d.bays}</Td>
                          <Td className="text-sm">
                            {notes.length || d.skill_gaps.length || dayArrivals.length ? (
                              <span className="flex flex-wrap gap-1">
                                {notes.map((n) => <Badge key={n} tone={n.includes("over") || n.includes("bays") || n.includes("closed") ? "red" : "amber"}>{n}</Badge>)}
                                {dayArrivals.map((w) => <Link key={w.id} href={`/maintenance/work-orders/${w.id}`}><Badge tone="amber">{w.number}: {arrivals.get(w.id)!.arrivesOn ? `part due ${shortDay(arrivals.get(w.id)!.arrivesOn!)}` : "part date unknown"}</Badge></Link>)}
                                {d.skill_gaps.map((g) => <Link key={g.id} href={`/maintenance/work-orders/${g.id}`}><Badge tone="amber">{g.number}: no {WO_CATEGORIES[g.category as keyof typeof WO_CATEGORIES]?.toLowerCase() ?? g.category} skill on shift</Badge></Link>)}
                              </span>
                            ) : <span className="text-muted">–</span>}
                          </Td>
                        </Tr>
                      );
                    })}
                  </tbody>
                </Table>
              </TableWrap>
            ) : (
              <CardBody><p className="text-sm text-muted">Capacity is not configured, so Taviron does not say whether the shop is over or under capacity.</p></CardBody>
            )}
          </Card>

          <div className="space-y-5">
            <Card>
              <CardHeader title="Shop" />
              <CardBody>
                {manage
                  ? <ShopSettingsForm initial={capacity.configured ? { bays: capacity.bays, shiftStart: capacity.shift_start.slice(0, 5), shiftEnd: capacity.shift_end.slice(0, 5), workDays: capacity.work_days } : null} />
                  : capacity.configured
                    ? <p className="text-sm text-ink">{capacity.bays} bays · {capacity.shift_start.slice(0, 5)}–{capacity.shift_end.slice(0, 5)}</p>
                    : <p className="text-sm text-muted">Not set up yet.</p>}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Mechanic skills" description="Optional. Once any are recorded, scheduled jobs no mechanic on shift can do are flagged." />
              <ul className="divide-y divide-line">
                {mechanics.map((m) => <SkillsRow key={m.id} userId={m.id} name={m.name} skills={skills.get(m.id) ?? []} canManage={manage} />)}
                {mechanics.length === 0 && <li className="px-5 py-3 text-sm text-muted sm:px-6">Nobody&apos;s role can do maintenance yet.</li>}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
