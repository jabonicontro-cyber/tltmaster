import Link from "next/link";
import { CalendarClock, Plus, Wrench } from "lucide-react";
import { SafetyBadge, UrgencyBadge, WoStatusBadge } from "@/components/maintenance/bits";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { addDays, formatDate } from "@/lib/dates";
import { rankWorkOrders, workOrderUnit } from "@/lib/maintenance";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listAssignees, listDriverOptions, listOpenWorkOrders, listPmStatus, listTrailers, listTrucks } from "@/server/data/maintenance";
import { businessToday } from "@/server/data/settings";
import { listShopWorkload } from "@/server/data/maintenance-crew";
import { zonedTimeToUtc } from "@/lib/dates";
import { Badge } from "@/components/ui/badge";
import { Donut } from "@/components/reports/charts";
import { cn } from "@/lib/cn";
import { PM_STATES, WO_URGENCIES, type WoStatus } from "@/lib/maintenance";
import type { PmRow } from "@/server/data/maintenance";
import { ChevronRight, ShieldAlert } from "lucide-react";

export const metadata = { title: "Maintenance" };

// The work-order board's columns (redesign 2026-10-26): every open status lands in exactly one column.
const COLUMNS: Array<{ key: string; label: string; statuses: WoStatus[]; bar: string }> = [
  { key: "new", label: "New", statuses: ["reported", "triaged"], bar: "bg-sky-400" },
  { key: "scheduled", label: "Scheduled", statuses: ["scheduled"], bar: "bg-indigo-400" },
  { key: "in_progress", label: "In progress", statuses: ["in_progress"], bar: "bg-brand" },
  { key: "awaiting_parts", label: "Awaiting parts", statuses: ["awaiting_parts"], bar: "bg-amber-400" },
  { key: "awaiting_inspection", label: "Awaiting inspection", statuses: ["awaiting_inspection"], bar: "bg-violet-400" },
];

/** How much of a preventive interval is used (the furthest of days, miles and hours); null when nothing is recorded. */
function intervalUsed(p: PmRow, today: string): number | null {
  const parts: number[] = [];
  if (p.interval_days && p.last_done_on) parts.push(daysBetween(p.last_done_on, today) / p.interval_days);
  if (p.interval_miles && p.last_done_miles !== null && p.current_miles !== null) parts.push((p.current_miles - p.last_done_miles) / p.interval_miles);
  if (p.interval_hours && p.last_done_hours !== null && p.current_hours !== null) parts.push((p.current_hours - p.last_done_hours) / p.interval_hours);
  return parts.length ? Math.max(0, ...parts) : null;
}

function daysBetween(fromIso: string, today: string) {
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(fromIso.slice(0, 10))) / 86400_000));
}

export default async function MaintenancePage() {
  const access = await requirePagePermission("maintenance.view");
  const [{ today, timezone }, open, pm, trucks, trailers, drivers, assignees] = await Promise.all([
    businessToday(), listOpenWorkOrders(), listPmStatus(), listTrucks(), listTrailers(), listDriverOptions(), listAssignees(),
  ]);
  // Monday of this week, in the company's time zone.
  const weekStart = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const shop = await listShopWorkload(open.map((w) => w.id), zonedTimeToUtc(weekStart, "00:00", timezone) ?? `${weekStart}T00:00:00Z`);
  const truckById = new Map(trucks.map((t) => [t.id, t]));
  const trailerById = new Map(trailers.map((t) => [t.id, t]));
  const truckUnits = new Map(trucks.map((t) => [t.id, t.unit_number]));
  const trailerUnits = new Map(trailers.map((t) => [t.id, t.unit_number]));
  const heldTrucks = new Set(drivers.map((d) => d.primary_truck_id).filter(Boolean));
  // Trucks first, then trailers; a trailer links to its own work orders.
  const outOfService = [
    ...trucks.filter((t) => t.active && t.service_status === "out_of_service").map((t) => ({ ...t, label: `Truck ${t.unit_number}`, href: `/maintenance/work-orders?truck=${t.id}&view=all`, expected_return_date: t.expected_return_date })),
    ...trailers.filter((t) => t.active && t.service_status === "out_of_service").map((t) => ({ ...t, label: `Trailer ${t.unit_number}`, href: `/maintenance/work-orders?trailer=${t.id}&view=all`, expected_return_date: null as string | null })),
  ];
  const immediate = open.filter((w) => w.urgency === "immediate" || w.safety_critical);
  const awaiting = open.filter((w) => w.status === "awaiting_inspection");
  const overdue = pm.filter((p) => p.state === "overdue");
  const dueSoon = pm.filter((p) => p.state === "due_soon");
  const unknownPm = pm.filter((p) => p.state === "unknown" || p.readings_stale);

  const ranked = rankWorkOrders(
    open.map((w) => {
      const trailer = w.trailer_id ? trailerById.get(w.trailer_id) : undefined;
      const unit = trailer ?? (w.truck_id ? truckById.get(w.truck_id) : undefined);
      const pulledBy = trailer ? trailer.default_truck_id : w.truck_id;
      return { ...w, truck_out_of_service: unit?.service_status === "out_of_service", truck_has_driver: Boolean(pulledBy && heldTrucks.has(pulledBy)) };
    }),
    today,
  );
  const rankOf = new Map(ranked.map((r, i) => [r.item.id, i]));
  const top = ranked.slice(0, 8);
  // Fleet availability (trucks): out of service, in the shop (open work in progress, waiting for parts or inspection),
  // or available. Each active truck counts once.
  const activeTrucks = trucks.filter((t) => t.active);
  const shopWork = new Set(open.filter((w) => w.truck_id && ["in_progress", "awaiting_parts", "awaiting_inspection"].includes(w.status)).map((w) => w.truck_id));
  const oosTrucks = activeTrucks.filter((t) => t.service_status === "out_of_service").length;
  const inShopTrucks = activeTrucks.filter((t) => t.service_status !== "out_of_service" && shopWork.has(t.id)).length;
  const availableTrucks = activeTrucks.length - oosTrucks - inShopTrucks;
  const pmHealth = pm
    .map((p) => ({ p, used: intervalUsed(p, today) }))
    .sort((a, b) => (b.used ?? -1) - (a.used ?? -1))
    .slice(0, 6);

  const names = new Map(assignees.map((a) => [a.id, a.name]));
  const workload = new Map<string, { open: number; inProgress: number; hours: number }>();
  for (const w of open) {
    const k = w.assigned_to ?? "";
    const cur = workload.get(k) ?? { open: 0, inProgress: 0, hours: 0 };
    cur.open += 1;
    if (w.status === "in_progress") cur.inProgress += 1;
    cur.hours += w.labor_hours ?? 0;
    workload.set(k, cur);
  }
  const weekEnd = addDays(today, 7);
  const upcoming = open.filter((w) => w.scheduled_for && w.scheduled_for >= today && w.scheduled_for <= weekEnd)
    .sort((a, b) => (a.scheduled_for ?? "").localeCompare(b.scheduled_for ?? ""));
  // Possible replacements: active, in-service trucks that are nobody's primary truck. A hint, not an assignment.
  const spares = trucks.filter((t) => t.active && t.service_status === "in_service" && !heldTrucks.has(t.id));

  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Shop work, preventive maintenance and returning trucks to service. Safety-critical defects keep a truck out of dispatch until an authorized inspection clears it."
        actions={can(access, "maintenance.manage") && <ButtonLink href="/maintenance/work-orders/new" icon={<Plus className="size-4" />}>New work order</ButtonLink>}
      />
      <MaintenanceTabs active="overview" />

      <section aria-label="Overview" className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardHeader title="Availability" description={`${activeTrucks.length} active truck${activeTrucks.length === 1 ? "" : "s"}${trailers.filter((t) => t.active).length ? ` · ${trailers.filter((t) => t.active && t.service_status === "out_of_service").length} of ${trailers.filter((t) => t.active).length} trailers out of service` : ""}`} />
          <div className="flex flex-wrap items-center gap-6 px-5 pb-5 sm:px-6">
            <Donut
              parts={[{ label: "Available", value: availableTrucks, color: "#16a34a" }, { label: "In the shop", value: inShopTrucks, color: "#f59e0b" }, { label: "Out of service", value: oosTrucks, color: "#64748b" }]}
              center={String(activeTrucks.length)}
              sub="trucks"
              label={`Trucks: ${availableTrucks} available, ${inShopTrucks} in the shop, ${oosTrucks} out of service`}
            />
            <ul className="min-w-44 flex-1 space-y-2.5 text-sm" aria-label="Truck availability">
              {[
                { label: "Available", n: availableTrucks, color: "#16a34a", href: "/fleet/trucks" },
                { label: "In the shop", n: inShopTrucks, color: "#f59e0b", href: "/maintenance/work-orders?view=open" },
                { label: "Out of service", n: oosTrucks, color: "#64748b", href: "#out-of-service" },
              ].map((x) => (
                <li key={x.label}>
                  <Link href={x.href} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-1 py-0.5 hover:bg-surface">
                    <span className="size-2.5 rounded-full" style={{ background: x.color }} aria-hidden />
                    <span className="text-ink">{x.label}</span>
                    <span className="font-semibold tabular">{x.n}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Card>
        <Card>
          <CardHeader title="Needs attention" description="Each line opens the records behind it." />
          <ul className="divide-y divide-line/70 border-t border-line/70" aria-label="Needs attention">
            {[
              { label: "Immediate or safety-critical", n: immediate.length, href: "/maintenance/work-orders?view=immediate", tone: "critical" as const, chip: "Act now" },
              { label: "Preventive service overdue", n: overdue.length, href: "/maintenance/preventive?state=overdue", tone: "critical" as const, chip: "Overdue" },
              { label: "Preventive service due soon", n: dueSoon.length, href: "/maintenance/preventive?state=due_soon", tone: "amber" as const, chip: "Due soon" },
              { label: "Repairs awaiting clearance", n: awaiting.length, href: "/maintenance/clearance", tone: "amber" as const, chip: "Inspection" },
              { label: "Open work orders with no lead mechanic", n: (workload.get("")?.open ?? 0), href: "/maintenance/work-orders?assigned=none", tone: "amber" as const, chip: "Unassigned" },
              { label: "Schedules missing data", n: unknownPm.length, href: "/maintenance/preventive?state=unknown", tone: "gray" as const, chip: "Needs data" },
            ].map((x) => (
              <li key={x.label}>
                <Link href={x.href} className="grid grid-cols-[minmax(0,1fr)_3rem_7rem_auto] items-center gap-3 px-5 py-2.5 text-sm hover:bg-surface sm:px-6">
                  <span className="truncate text-ink">{x.label}</span>
                  <span className={cn("text-right font-semibold tabular", x.n > 0 && x.tone === "critical" && "text-critical")}>{x.n}</span>
                  <span className="flex justify-end">{x.n > 0 ? <Badge tone={x.tone === "critical" ? "critical-soft" : x.tone}>{x.chip}</Badge> : <span className="text-xs text-muted">None</span>}</span>
                  <ChevronRight className="size-4 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section aria-label="Work order board" className="mb-5">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">Open work orders</h2>
          <Link href="/maintenance/work-orders?view=open" className="text-sm font-semibold text-ink hover:underline">List view</Link>
        </div>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((col) => {
            const items = open.filter((w) => col.statuses.includes(w.status)).sort((x, y) => (rankOf.get(x.id) ?? 99) - (rankOf.get(y.id) ?? 99));
            return (
              <div key={col.key} role="group" aria-label={`${col.label} (${items.length})`} className="flex w-64 shrink-0 flex-col rounded-panel bg-ink/[0.035] xl:w-auto xl:min-w-0 xl:flex-1">
                <span className={cn("h-1 rounded-t-panel", col.bar)} aria-hidden />
                <h3 className="px-3 pt-3 pb-2 text-sm font-semibold text-ink">{col.label} <span className="font-normal text-muted">({items.length})</span></h3>
                <ul className="flex-1 space-y-2 px-2 pb-2">
                  {items.map((w) => (
                    <li key={w.id}>
                      <Link href={`/maintenance/work-orders/${w.id}`} className={cn("block rounded-2xl border bg-card p-3 shadow-xs transition-colors hover:border-strong/30", w.safety_critical || w.urgency === "immediate" ? "urgent-edge" : "border-line/70")}>
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-muted tabular">
                          {w.safety_critical && <ShieldAlert className="size-3.5 text-critical" aria-label="Safety-critical" />}
                          {w.number}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-ink">{w.title}</p>
                        <p className="mt-1 truncate text-xs text-muted">{workOrderUnit(w, truckUnits, trailerUnits)}</p>
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <Badge tone={w.urgency === "immediate" ? "critical" : w.urgency === "high" ? "amber" : "gray"}>{WO_URGENCIES[w.urgency]}</Badge>
                          <span className="truncate text-xs text-muted">{w.assigned_to ? names.get(w.assigned_to) ?? "Former member" : "No lead"}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                  {items.length === 0 && <li className="px-1 py-3 text-center text-xs text-muted">Nothing here</li>}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Suggested shop order"
              description={<>Ranked by fixed rules: safety, urgency, downtime, due dates and parts. It only suggests — nothing is assigned or scheduled automatically. <span className="whitespace-nowrap">No AI service is connected.</span></>}
            />
            {top.length === 0 ? (
              <EmptyState title="No open work orders" description="New work orders and due preventive services appear here." icon={<Wrench className="size-6" />} />
            ) : (
              <ol className="divide-y divide-line">
                {top.map(({ item: w, reasons }, i) => (
                  <li key={w.id} className="flex gap-3 px-5 py-3 sm:px-6">
                    <span className="mt-0.5 w-5 shrink-0 text-right text-sm font-bold text-muted tabular">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/maintenance/work-orders/${w.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">{w.number} · {w.title}</Link>
                        {w.safety_critical && <SafetyBadge />}
                        <UrgencyBadge urgency={w.urgency} />
                        <WoStatusBadge status={w.status} />
                      </div>
                      <div className="text-sm text-muted">{workOrderUnit(w, truckUnits, trailerUnits)} · {reasons.join(" · ")}</div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card>
            <div id="out-of-service" className="scroll-mt-20" />
            <CardHeader title="Out of service" description="Downtime counts from when the unit was taken out of service." />
            {outOfService.length === 0 ? (
              <CardBody><p className="text-sm text-muted">Every active truck and trailer is in service.</p></CardBody>
            ) : (
              <TableWrap>
                <Table>
                  <thead><tr><Th>Unit</Th><Th>Reason</Th><Th>Down</Th><Th className="hidden sm:table-cell">Expected back</Th></tr></thead>
                  <tbody>
                    {outOfService.map((t) => (
                      <Tr key={t.id}>
                        <Td><Link href={t.href} className="font-semibold text-ink hover:underline">{t.label}</Link></Td>
                        <Td className="text-sm">{t.out_of_service_reason || "—"}</Td>
                        <Td className="tabular">{t.out_of_service_since ? `${daysBetween(t.out_of_service_since, today)} d` : "—"}</Td>
                        <Td className="hidden sm:table-cell">{t.expected_return_date ? formatDate(t.expected_return_date) : "Not set"}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
            {outOfService.length > 0 && (
              <CardBody className="border-t border-line text-sm text-muted">
                {spares.length
                  ? <>Possible replacements (in service, nobody&apos;s primary truck): <strong className="text-ink">{spares.slice(0, 8).map((t) => t.unit_number).join(", ")}</strong>. Dispatchers choose; nothing is reassigned automatically.</>
                  : "No spare truck is free: every in-service truck is someone's primary truck."}
              </CardBody>
            )}
          </Card>

          <Card>
            <CardHeader title="Scheduled in the next 7 days" description="Drivers of these trucks (and of the trucks that usually pull these trailers) see the appointment on My Day." />
            {upcoming.length === 0 ? (
              <CardBody><p className="text-sm text-muted">Nothing scheduled.</p></CardBody>
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5 sm:px-6">
                    <CalendarClock className="size-4 text-muted" aria-hidden />
                    <span className="font-medium tabular">{formatDate(w.scheduled_for)}</span>
                    <Link href={`/maintenance/work-orders/${w.id}`} className="text-ink hover:underline">{w.number} · {w.title}</Link>
                    <span className="text-sm text-muted">{workOrderUnit(w, truckUnits, trailerUnits)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          {shop.installed ? (
            <Card>
              <CardHeader title="Mechanics" description="Who is working now, their open jobs (as lead or helping) and the time logged this week." />
              <ul className="divide-y divide-line text-sm">
                {shop.mechanics.map((m) => (
                  <li key={m.userId} className="px-5 py-2.5 sm:px-6">
                    <div className="flex items-center justify-between gap-2">
                      <Link href={`/maintenance/work-orders?assigned=${m.userId}`} className="font-medium text-ink hover:underline">{m.name}</Link>
                      <span className="tabular text-muted">{Math.floor(m.weekMinutes / 60)} h {String(m.weekMinutes % 60).padStart(2, "0")} this week</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-muted">
                      {m.working
                        ? <><Badge tone="green">Working</Badge><Link href={`/maintenance/work-orders/${m.working.workOrderId}`} className="text-ink hover:underline">{m.working.number}</Link></>
                        : <span>Not on a timer</span>}
                      <span>· {m.leadJobs} leading · {m.helperJobs} helping</span>
                    </div>
                  </li>
                ))}
                {shop.mechanics.length === 0 && <li className="px-5 py-3 text-muted sm:px-6">Nobody&apos;s role can do maintenance yet.</li>}
                {(workload.get("")?.open ?? 0) > 0 && (
                  <li className="px-5 py-2.5 sm:px-6">
                    <Link href="/maintenance/work-orders?assigned=none" className="font-medium text-critical hover:underline">{workload.get("")!.open} open work order{workload.get("")!.open === 1 ? "" : "s"} with no lead mechanic</Link>
                  </li>
                )}
              </ul>
              <CardBody className="border-t border-line text-xs text-muted">
                Shop capacity (bays, shift hours) is not configured yet, so Taviron cannot say whether the shop is over capacity.
              </CardBody>
            </Card>
          ) : (
          <Card>
            <CardHeader title="Technician workload" description="Open work orders per mechanic and the labor hours recorded on them." />
            <ul className="divide-y divide-line text-sm">
              {[...workload.entries()].sort((a, b) => b[1].open - a[1].open).map(([who, w]) => (
                <li key={who || "none"} className="flex items-center justify-between gap-2 px-5 py-2.5 sm:px-6">
                  <Link href={`/maintenance/work-orders?assigned=${who || "none"}`} className={who ? "font-medium text-ink hover:underline" : "font-medium text-muted hover:underline"}>
                    {who ? names.get(who) ?? "Former member" : "Unassigned"}
                  </Link>
                  <span className="tabular text-muted">{w.open} open · {w.inProgress} in progress · {w.hours.toLocaleString("en-US", { maximumFractionDigits: 1 })} h</span>
                </li>
              ))}
              {workload.size === 0 && <li className="px-5 py-3 text-muted sm:px-6">No open work.</li>}
            </ul>
            <CardBody className="border-t border-line text-xs text-muted">
              Shop capacity (bays, shift hours) is not configured yet, so Taviron cannot say whether the shop is over capacity.
            </CardBody>
          </Card>
          )}

          <Card>
            <CardHeader title="Service due" description="How much of each preventive interval is used (days, miles or hours, whichever is furthest)." />
            {pmHealth.length === 0 ? (
              <CardBody><p className="text-sm text-muted">No preventive schedules yet.</p></CardBody>
            ) : (
              <ul className="space-y-3.5 px-5 pb-5 sm:px-6" aria-label="Service due">
                {pmHealth.map(({ p, used }) => (
                  <li key={p.schedule_id}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate"><span className="font-semibold text-ink">Truck {p.unit_number}</span> <span className="text-muted">· {p.name}</span></span>
                      <span className={cn("shrink-0 text-xs font-semibold tabular", p.state === "overdue" ? "text-critical" : p.state === "due_soon" ? "text-amber-800" : "text-muted")}>
                        {used === null ? PM_STATES[p.state] : `${Math.round(used * 100)}%`}
                      </span>
                    </div>
                    <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-line/70" aria-hidden>
                      {used !== null && <span className={cn("block h-full rounded-full", p.state === "overdue" ? "bg-critical" : p.state === "due_soon" ? "bg-amber-400" : "bg-green-600")} style={{ width: `${Math.min(100, Math.round(used * 100))}%` }} />}
                    </span>
                    <p className="mt-1 text-xs text-muted">{used === null ? "No last service or reading recorded" : p.next_due_on ? `Due by ${formatDate(p.next_due_on)}${p.next_due_miles ? ` or ${p.next_due_miles.toLocaleString("en-US")} mi` : ""}` : p.next_due_miles ? `Due at ${p.next_due_miles.toLocaleString("en-US")} mi` : PM_STATES[p.state]}</p>
                  </li>
                ))}
                <li><Link href="/maintenance/preventive" className="text-sm font-semibold text-ink hover:underline">All {pm.length} schedule{pm.length === 1 ? "" : "s"}</Link></li>
              </ul>
            )}
          </Card>

        </div>
      </div>
    </>
  );
}
