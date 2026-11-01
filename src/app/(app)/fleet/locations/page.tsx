import Link from "next/link";
import { FleetNav } from "@/components/fleet/fleet-nav";
import { RecordHoursButton, RecordPositionButton } from "@/components/fleet/telematics";
import { RouteMap } from "@/components/routing/route-map";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { can } from "@/lib/permissions";
import { DUTY_LABEL, DUTY_TONE, RECORD_SOURCE_LABEL, ageLabel, clockLabel, hoursVerified, isStale } from "@/lib/telematics";
import { requirePagePermission } from "@/server/auth";
import { driverOptions, truckOptions } from "@/server/data/fleet";
import { businessToday } from "@/server/data/settings";
import { latestTelematics, telematicsStatus } from "@/server/data/telematics";
import { routingStatus } from "@/server/routing/service";

export const metadata = { title: "Locations and hours" };

// GPS and hours (B101): each truck's last recorded position and each driver's last recorded hours, with their age and
// source. Nothing is estimated; data older than the company's limit is marked stale.

export default async function LocationsPage() {
  const access = await requirePagePermission("fleet.view");
  const status = await telematicsStatus();
  const canRecord = can(access, "dispatch.edit");
  const header = (
    <>
      <PageHeader title="Fleet" description="Trucks, trailers and drivers, with what makes each one ready — or not ready — for work." />
      <FleetNav active="Locations and hours" />
    </>
  );
  if (!status.installed) {
    return <>{header}<Notice title="Not available yet">GPS and hours need a database update that has not been installed yet.</Notice></>;
  }
  if (status.source === "none") {
    return (
      <>
        {header}
        <EmptyState
          title="GPS and hours are off"
          description={can(access, "settings.manage") ? "Choose whether dispatch enters positions and hours by hand or your GPS/ELD provider sends them." : "An owner can turn them on in Settings → GPS and hours."}
          action={can(access, "settings.manage") ? <Link href="/settings?tab=gps" className="text-sm font-semibold text-brand-fg underline">Open Settings → GPS and hours</Link> : undefined}
        />
      </>
    );
  }

  const [{ positions, hours }, trucks, drivers, { today }] = await Promise.all([latestTelematics(), truckOptions(), driverOptions(), businessToday()]);
  const routing = routingStatus(access);
  const now = new Date();
  const activeTrucks = trucks.filter((t) => t.active);
  const activeDrivers = drivers.filter((d) => d.active);
  const truckName = new Map(trucks.map((t) => [t.id, `Truck ${t.unit_number}`]));
  const located = activeTrucks.filter((t) => positions.has(t.id));
  const current = located.filter((t) => !isStale(positions.get(t.id)!.recordedAt, status.staleMinutes, now));
  const withHours = activeDrivers.filter((d) => hours.has(d.id));
  const lowDrive = withHours.filter((d) => {
    const h = hours.get(d.id)!;
    return h.driveLeft !== null && h.driveLeft < 60 && !isStale(h.asOf, status.staleMinutes, now);
  });

  return (
    <>
      {header}
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Badge tone={status.source === "feed" ? "blue" : "gray"}>{status.source === "feed" ? "Provider feed" : "Entered by hand"}</Badge>
        <span className="text-muted">Current means recorded in the last {status.staleMinutes} minutes.{status.source === "feed" && status.lastFeedAt ? ` Last feed ${ageLabel(status.lastFeedAt, now).toLowerCase()}.` : status.source === "feed" ? " The feed has not sent anything yet." : ""}</span>
        {canRecord && (
          <span className="ml-auto flex flex-wrap gap-2">
            <RecordPositionButton trucks={activeTrucks.map((t) => ({ id: t.id, label: `Truck ${t.unit_number}` }))} />
            <RecordHoursButton drivers={activeDrivers.map((d) => ({ id: d.id, label: d.display_name }))} />
          </span>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardHeader title="Trucks" description={`${current.length} of ${activeTrucks.length} with a current position · ${located.length - current.length} stale · ${activeTrucks.length - located.length} never recorded`} />
          <CardBody className="space-y-4">
            {current.length > 0 ? (
              <RouteMap stops={current.map((t) => ({ point: { lat: positions.get(t.id)!.latitude, lng: positions.get(t.id)!.longitude }, label: truckName.get(t.id)! }))} tiles={routing.state === "ready"} title="Current truck positions" connect={false} />
            ) : <p className="text-sm text-muted">No truck has a current position.</p>}
            <ul className="divide-y divide-line" aria-label="Truck positions">
              {activeTrucks.map((t) => {
                const p = positions.get(t.id);
                const stale = p ? isStale(p.recordedAt, status.staleMinutes, now) : false;
                const n = current.findIndex((c) => c.id === t.id);
                return (
                  <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" aria-label={truckName.get(t.id)}>
                    <span className="w-6 text-right text-xs text-muted tabular">{n >= 0 ? n + 1 : ""}</span>
                    <Link href={`/fleet/trucks/${t.id}`} className="font-medium hover:underline">{truckName.get(t.id)}</Link>
                    {p ? (
                      <>
                        <span className="text-sm text-muted tabular">{p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}{p.speedMph !== null ? ` · ${p.speedMph > 0 ? `${Math.round(p.speedMph)} mph` : "stopped"}` : ""}</span>
                        {p.note && <span className="text-sm text-muted">· {p.note}</span>}
                        <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                          {stale && <Badge tone="amber">Stale</Badge>}
                          {ageLabel(p.recordedAt, now)} · {RECORD_SOURCE_LABEL[p.source]}
                        </span>
                      </>
                    ) : <span className="ml-auto text-xs text-muted">No position recorded</span>}
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Drivers' hours"
            description={`${withHours.length} of ${activeDrivers.length} with recorded hours${lowDrive.length ? ` · ${lowDrive.length} under 1 h of drive time` : ""}`}
          />
          <CardBody>
            {activeDrivers.length === 0 ? <p className="text-sm text-muted">No active drivers.</p> : (
              <ul className="divide-y divide-line" aria-label="Drivers' hours">
                {activeDrivers.map((d) => {
                  const h = hours.get(d.id);
                  const stale = h ? isStale(h.asOf, status.staleMinutes, now) : false;
                  const verified = hoursVerified(h, status, today, today, now);
                  return (
                    <li key={d.id} className="py-2.5" aria-label={d.display_name}>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/fleet/drivers/${d.id}`} className="font-medium hover:underline">{d.display_name}</Link>
                        {h && <Badge tone={DUTY_TONE[h.dutyStatus]}>{DUTY_LABEL[h.dutyStatus]}</Badge>}
                        {verified && <Badge tone="green">Verified for today</Badge>}
                        {stale && <Badge tone="amber">Stale</Badge>}
                      </div>
                      {h ? (
                        <p className="mt-0.5 text-sm text-muted">
                          <span className={h.driveLeft !== null && h.driveLeft < 60 && !stale ? "font-medium text-critical" : undefined}>Drive {clockLabel(h.driveLeft) ?? "—"}</span>
                          {" · "}Shift {clockLabel(h.shiftLeft) ?? "—"} · Cycle {clockLabel(h.cycleLeft) ?? "—"}
                          <span className="block text-xs">{ageLabel(h.asOf, now)} · {RECORD_SOURCE_LABEL[h.source]}</span>
                        </p>
                      ) : <p className="mt-0.5 text-sm text-muted">No hours recorded</p>}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
              Only current hours from a provider feed count as verified for dispatch. Hand-entered hours are for reference; dispatchers still confirm each driver&apos;s hours.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
