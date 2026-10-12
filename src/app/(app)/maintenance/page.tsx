import Link from "next/link";
import { Bot, CalendarClock, Plus, Wrench } from "lucide-react";
import { StatCard, SafetyBadge, UrgencyBadge, WoStatusBadge } from "@/components/maintenance/bits";
import { MaintenanceTabs } from "@/components/maintenance/tabs";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { addDays, formatDate } from "@/lib/dates";
import { rankWorkOrders } from "@/lib/maintenance";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { listAssignees, listDriverOptions, listOpenWorkOrders, listPmStatus, listTrucks } from "@/server/data/maintenance";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Maintenance" };

function daysBetween(fromIso: string, today: string) {
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(fromIso.slice(0, 10))) / 86400_000));
}

export default async function MaintenancePage() {
  const access = await requirePagePermission("maintenance.view");
  const [{ today }, open, pm, trucks, drivers, assignees] = await Promise.all([
    businessToday(), listOpenWorkOrders(), listPmStatus(), listTrucks(), listDriverOptions(), listAssignees(),
  ]);
  const truckById = new Map(trucks.map((t) => [t.id, t]));
  const heldTrucks = new Set(drivers.map((d) => d.primary_truck_id).filter(Boolean));
  const outOfService = trucks.filter((t) => t.active && t.service_status === "out_of_service");
  const immediate = open.filter((w) => w.urgency === "immediate" || w.safety_critical);
  const awaiting = open.filter((w) => w.status === "awaiting_inspection");
  const overdue = pm.filter((p) => p.state === "overdue");
  const dueSoon = pm.filter((p) => p.state === "due_soon");
  const unknownPm = pm.filter((p) => p.state === "unknown" || p.readings_stale);

  const ranked = rankWorkOrders(
    open.map((w) => ({ ...w, truck_out_of_service: truckById.get(w.truck_id)?.service_status === "out_of_service", truck_has_driver: heldTrucks.has(w.truck_id) })),
    today,
  ).slice(0, 8);

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

      <section aria-label="Overview" className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard href="/maintenance/work-orders?view=immediate" label="Immediate / safety" value={immediate.length} alert={immediate.length > 0} hint="Open, immediate urgency or safety-critical" />
        <StatCard href="/maintenance/preventive?state=overdue" label="Overdue PM" value={overdue.length} alert={overdue.length > 0} hint="Preventive services past due" />
        <StatCard href="/maintenance/preventive?state=due_soon" label="Due soon" value={dueSoon.length} hint="Inside the warning window" />
        <StatCard href="/maintenance/work-orders?view=open" label="Open work orders" value={open.length} />
        <StatCard href="#out-of-service" label="Out of service" value={outOfService.length} hint="Trucks not available to dispatch" />
        <StatCard href="/maintenance/clearance" label="Awaiting clearance" value={awaiting.length} hint="Repairs waiting for inspection" />
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Suggested shop order"
              description="Ranked by fixed rules: safety, urgency, downtime, due dates and parts. It only suggests — nothing is assigned or scheduled automatically."
            />
            {ranked.length === 0 ? (
              <EmptyState title="No open work orders" description="New work orders and due preventive services appear here." icon={<Wrench className="size-6" />} />
            ) : (
              <ol className="divide-y divide-line">
                {ranked.map(({ item: w, reasons }, i) => (
                  <li key={w.id} className="flex gap-3 px-4 py-3 sm:px-5">
                    <span className="mt-0.5 w-5 shrink-0 text-right text-sm font-bold text-muted tabular">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/maintenance/work-orders/${w.id}`} className="font-semibold text-ink hover:text-brand-fg hover:underline">{w.number} · {w.title}</Link>
                        {w.safety_critical && <SafetyBadge />}
                        <UrgencyBadge urgency={w.urgency} />
                        <WoStatusBadge status={w.status} />
                      </div>
                      <div className="text-sm text-muted">Truck {truckById.get(w.truck_id)?.unit_number ?? "—"} · {reasons.join(" · ")}</div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card>
            <div id="out-of-service" className="scroll-mt-20" />
            <CardHeader title="Out of service" description="Downtime counts from when the truck was taken out of service." />
            {outOfService.length === 0 ? (
              <CardBody><p className="text-sm text-muted">Every active truck is in service.</p></CardBody>
            ) : (
              <TableWrap>
                <Table>
                  <thead><tr><Th>Truck</Th><Th>Reason</Th><Th>Down</Th><Th className="hidden sm:table-cell">Expected back</Th></tr></thead>
                  <tbody>
                    {outOfService.map((t) => (
                      <Tr key={t.id}>
                        <Td><Link href={`/maintenance/work-orders?truck=${t.id}&view=all`} className="font-semibold text-ink hover:underline">{t.unit_number}</Link></Td>
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
            <CardHeader title="Scheduled in the next 7 days" description="Drivers of these trucks see the appointment on My Day." />
            {upcoming.length === 0 ? (
              <CardBody><p className="text-sm text-muted">Nothing scheduled.</p></CardBody>
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.map((w) => (
                  <li key={w.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:px-5">
                    <CalendarClock className="size-4 text-muted" aria-hidden />
                    <span className="font-medium tabular">{formatDate(w.scheduled_for)}</span>
                    <Link href={`/maintenance/work-orders/${w.id}`} className="text-ink hover:underline">{w.number} · {w.title}</Link>
                    <span className="text-sm text-muted">Truck {truckById.get(w.truck_id)?.unit_number ?? "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Technician workload" description="Open work orders per mechanic and the labor hours recorded on them." />
            <ul className="divide-y divide-line text-sm">
              {[...workload.entries()].sort((a, b) => b[1].open - a[1].open).map(([who, w]) => (
                <li key={who || "none"} className="flex items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                  <Link href={`/maintenance/work-orders?assigned=${who || "none"}`} className={who ? "font-medium text-ink hover:underline" : "font-medium text-muted hover:underline"}>
                    {who ? names.get(who) ?? "Former member" : "Unassigned"}
                  </Link>
                  <span className="tabular text-muted">{w.open} open · {w.inProgress} in progress · {w.hours.toLocaleString("en-US", { maximumFractionDigits: 1 })} h</span>
                </li>
              ))}
              {workload.size === 0 && <li className="px-4 py-3 text-muted sm:px-5">No open work.</li>}
            </ul>
            <CardBody className="border-t border-line text-xs text-muted">
              Shop capacity (bays, shift hours) is not configured yet, so Taviron cannot say whether the shop is over capacity.
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Preventive maintenance data" />
            <CardBody className="space-y-2 text-sm">
              <p>{pm.length} active schedule{pm.length === 1 ? "" : "s"}.</p>
              {unknownPm.length > 0 ? (
                <p>
                  <Link href="/maintenance/preventive?state=unknown" className="font-medium text-ink underline">{unknownPm.length} need data</Link>
                  <span className="text-muted"> — no last-service record, no reading, or a reading older than 30 days. They are not shown as “OK”.</span>
                </p>
              ) : pm.length > 0 && <p className="text-muted">Every schedule has the data it needs.</p>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="AI recommendations" />
            <CardBody className="flex gap-3 text-sm">
              <Bot className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
              <p className="text-muted">
                <strong className="text-ink">No AI service is connected.</strong> Taviron does not produce AI diagnoses, part
                availability or savings estimates. The shop order above comes from the fixed rules it lists.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
