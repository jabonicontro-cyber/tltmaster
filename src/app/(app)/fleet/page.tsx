import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, CalendarClock, Container, FileWarning, ShieldAlert, Truck, UserRound, Wrench } from "lucide-react";
import { EligibilityChecker } from "@/components/fleet/eligibility-checker";
import { QualificationBadge } from "@/components/fleet/fleet-badges";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";
import { addDays, formatDate } from "@/lib/dates";
import { EXPIRY_WARNING_DAYS, eligibilityMessage } from "@/lib/fleet/eligibility";
import { qualificationName, TRAILER_TYPE_LABELS, TRUCK_TYPE_LABELS } from "@/lib/fleet/labels";
import { requirePagePermission } from "@/server/auth";
import { driverOptions, fleetContext, fleetOverview, trailerOptions, truckOptions } from "@/server/data/fleet";
import { documentAttention } from "@/lib/fleet/availability";
import { CappedList } from "@/components/ui/capped-list";
import { Badge } from "@/components/ui/badge";
import { can } from "@/lib/permissions";

export const metadata = { title: "Fleet" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Stat({ icon, label, value, sub, href, warn }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; href: string; warn?: boolean }) {
  return (
    <Link href={href} className="block h-full">
      <div className="flex h-full items-start gap-3 rounded-panel border border-line/70 bg-card shadow-card p-4 transition-colors hover:border-strong/40">
        <div className={cn("rounded-xl p-2", warn ? "bg-amber-50 text-amber-800" : "bg-surface text-ink")}>{icon}</div>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-muted">{warn && <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />}{label}</p>
          <p className="text-2xl font-semibold tracking-tight text-ink tabular">{value}</p>
          {sub && <p className="text-sm text-muted">{sub}</p>}
        </div>
      </div>
    </Link>
  );
}

export default async function FleetPage() {
  const access = await requirePagePermission("fleet.view");
  const [o, trucks, trailers, drivers, ctx] = await Promise.all([fleetOverview(), truckOptions(), trailerOptions(), driverOptions(), fleetContext({ maintenance: can(access, "maintenance.view") })]);
  const activeTrucks = trucks.filter((t) => t.active);
  const restricted = activeTrucks.filter((t) => (ctx.maintenance.openByTruck.get(t.id) ?? []).some((w) => w.safety_critical));
  const pmOverdue = activeTrucks.filter((t) => (ctx.maintenance.pmByTruck.get(t.id)?.overdue ?? 0) > 0);
  const scheduled = activeTrucks.flatMap((t) => (ctx.maintenance.openByTruck.get(t.id) ?? [])
    .filter((w) => w.scheduled_for && w.scheduled_for >= o.today && w.scheduled_for <= addDays(o.today, 7) && w.status === "scheduled")
    .map((w) => ({ truck: t, wo: w })));
  const docAttention = [...activeTrucks.map((t) => ({ kind: "truck" as const, v: t })), ...trailers.filter((t) => t.active).map((t) => ({ kind: "trailer" as const, v: t }))]
    .map((x) => ({ ...x, att: documentAttention(ctx.documents.byVehicle.get(x.v.id) ?? [], o.today) }))
    .filter((x) => x.att.expired.length || x.att.expiring.length);
  const soon = addDays(o.today, EXPIRY_WARNING_DAYS);
  const down = [
    ...o.trucks.outOfService.map((e) => ({ ...e, kind: "truck" as const })),
    ...o.trailers.outOfService.map((e) => ({ ...e, kind: "trailer" as const })),
  ];
  const empty = o.trucks.active + o.trailers.active + o.drivers.active === 0;

  return (
    <>
      <PageHeader title="Fleet" description="Trucks, trailers and drivers, with what makes each one ready — or not ready — for work." />
      <FleetNav active="Overview" />

      {empty && (
        <Card className="mb-5">
          <div className="px-5 py-8 text-center">
            <p className="text-lg font-bold">Nothing in the fleet yet</p>
            <p className="mt-1 text-muted">
              Start with your trucks (unit numbers are enough), then trailers and drivers. Capacities and licenses can be added as you confirm them.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-3 text-sm font-semibold">
              <Link href="/fleet/trucks/new" className="underline">Add a truck</Link>
              <Link href="/fleet/trailers/new" className="underline">Add a trailer</Link>
              <Link href="/fleet/drivers/new" className="underline">Add a driver</Link>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<Truck className="size-5" />} label="Trucks in service" value={`${o.trucks.inService} / ${o.trucks.active}`} sub={o.trucks.capacityUnknown ? `${o.trucks.capacityUnknown} with unknown capacity` : "Active trucks"} href="/fleet/trucks?status=in_service" />
        <Stat icon={<Container className="size-5" />} label="Trailers in service" value={`${o.trailers.inService} / ${o.trailers.active}`} sub={o.trailers.capacityUnknown ? `${o.trailers.capacityUnknown} with unknown capacity` : "Active trailers"} href="/fleet/trailers?status=in_service" />
        <Stat icon={<UserRound className="size-5" />} label="Drivers eligible today" value={`${o.drivers.ready} / ${o.drivers.active}`} sub="Verified CDL and medical card" href="/fleet/drivers?status=ready" warn={o.drivers.notReady.length > 0} />
        <Stat icon={<Wrench className="size-5" />} label="Out of service" value={down.length} sub={`${plural(o.trucks.outOfService.length, "truck")} · ${plural(o.trailers.outOfService.length, "trailer")}`} href={o.trucks.outOfService.length === 0 && o.trailers.outOfService.length > 0 ? "/fleet/trailers?status=out_of_service" : "/fleet/trucks?status=out_of_service"} warn={down.length > 0} />
      </div>

      {(ctx.maintenance.available || ctx.documents.available) && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {ctx.maintenance.available && <Stat icon={<ShieldAlert className="size-5" />} label="Safety restricted" value={restricted.length} sub="Trucks waiting for repair or clearance" href="/fleet/trucks?maintenance=restricted" warn={restricted.length > 0} />}
          {ctx.maintenance.available && <Stat icon={<Wrench className="size-5" />} label="Preventive overdue" value={pmOverdue.length} sub="Trucks with an overdue service" href="/fleet/trucks?maintenance=overdue" warn={pmOverdue.length > 0} />}
          {ctx.maintenance.available && <Stat icon={<CalendarClock className="size-5" />} label="Shop visits, next 7 days" value={scheduled.length} sub="Scheduled work orders" href="/maintenance/work-orders?status=scheduled" />}
          {ctx.documents.available && <Stat icon={<FileWarning className="size-5" />} label="Documents expiring" value={docAttention.length} sub="Vehicles with an expired document or one due within 30 days" href="/fleet/trucks?documents=attention" warn={docAttention.some((x) => x.att.expired.length > 0)} />}
        </div>
      )}

      {docAttention.length > 0 && (
        <Card className="mt-5">
          <CardHeader title="Vehicle documents needing renewal" description="Expired, or expiring within 30 days. No reminders are sent — this list is the reminder." />
          <CappedList
            label="Vehicle documents needing renewal"
            items={docAttention.map(({ kind, v, att }) => (
              <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm sm:px-5">
                <Link href={`/fleet/${kind}s/${v.id}`} className="font-medium text-ink hover:underline">{kind === "truck" ? "Truck" : "Trailer"} {v.unit_number}</Link>
                {att.expired.map((d) => <span key={d.id} className="inline-flex items-center gap-1.5 text-muted"><Badge tone="red">Expired</Badge>{att.label(d.kind)} · {formatDate(d.expires_on)}</span>)}
                {att.expiring.map((d) => <span key={d.id} className="inline-flex items-center gap-1.5 text-muted"><Badge tone="amber">Due</Badge>{att.label(d.kind)} · {formatDate(d.expires_on)}</span>)}
              </li>
            ))}
          />
        </Card>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Out of service" description="Active equipment that cannot be assigned until it is returned to service." />
          {down.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted sm:px-5">All active equipment is in service.</p>
          ) : (
            <CappedList
              label="Out of service"
              items={down.map((e) => (
                <li key={e.id} className="px-4 py-2.5 sm:px-5">
                  <Link href={`/fleet/${e.kind}s/${e.id}`} className="font-semibold hover:underline">
                    {e.kind === "truck" ? "Truck" : "Trailer"} {e.unit_number}
                  </Link>
                  <span className="ml-2 text-sm">{e.out_of_service_reason}</span>
                  <div className="text-xs text-muted">
                    {e.out_of_service_since ? `Since ${formatDate(e.out_of_service_since.slice(0, 10))}` : ""}
                    {e.expected_return_date ? ` · expected back ${formatDate(e.expected_return_date)}` : " · no return date"}
                  </div>
                </li>
              ))}
            />
          )}
        </Card>
        <Card>
          <CardHeader title="Drivers needing attention" description={`Not eligible today, or a license or medical card expiring within ${EXPIRY_WARNING_DAYS} days.`} />
          {o.drivers.notReady.length === 0 && o.expiring.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted sm:px-5">Nothing needs attention.</p>
          ) : (
            <CappedList
              label="Drivers needing attention"
              items={[
              ...o.drivers.notReady.map((d) => (
                <li key={d.id} className="px-4 py-2.5 sm:px-5">
                  <Link href={`/fleet/drivers/${d.id}`} className="font-medium text-ink hover:underline">{d.display_name}</Link>
                  <div className="text-sm text-muted">
                    <AlertTriangle className="mr-1 inline size-3.5 text-amber-600" aria-hidden />
                    {d.readiness.blockers.map(eligibilityMessage).join(" ")}
                  </div>
                </li>
              )),
              ...o.expiring
                .filter(({ driver }) => driver.readiness.eligible)
                .map(({ driver, qualification }) => (
                  <li key={qualification.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 sm:px-5">
                    <Link href={`/fleet/drivers/${driver.id}`} className="font-semibold hover:underline">{driver.display_name}</Link>
                    <span className="text-sm">{qualificationName(qualification)}</span>
                    <QualificationBadge q={qualification} today={o.today} soon={soon} />
                  </li>
                )),
              ]}
            />
          )}
        </Card>
      </div>

      <div className="mt-5">
        <EligibilityChecker
          today={o.today}
          trucks={trucks.map((t) => ({ id: t.id, label: `${t.unit_number} — ${TRUCK_TYPE_LABELS[t.truck_type]}`, inactive: !t.active }))}
          trailers={trailers.map((t) => ({ id: t.id, label: `${t.unit_number} — ${TRAILER_TYPE_LABELS[t.trailer_type]}`, inactive: !t.active }))}
          drivers={drivers.map((d) => ({ id: d.id, label: d.display_name, inactive: !d.active }))}
        />
      </div>
    </>
  );
}
