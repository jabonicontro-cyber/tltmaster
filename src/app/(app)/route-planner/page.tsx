import Link from "next/link";
import { MapPin, Route, Truck } from "lucide-react";
import { SiteLocationForm, YardLocationForm } from "@/components/routing/location-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { addDays, formatDateLong, isIsoDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { buildRoutes, formatMinutes, routeTotals, YARD } from "@/lib/routing/route";
import { requirePagePermission } from "@/server/auth";
import { getRouteDay } from "@/server/data/routes";
import { businessToday } from "@/server/data/settings";
import { addRoadEstimates, routingStatus } from "@/server/routing/service";

export const metadata = { title: "Route Planner" };

type Search = { date?: string; truck?: string };

export default async function RoutePlannerPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("dispatch.view");
  const sp = await searchParams;
  const { today } = await businessToday();
  const date = sp.date && isIsoDate(sp.date) && sp.date >= addDays(today, -30) && sp.date <= addDays(today, 30) ? sp.date : today;
  const day = await getRouteDay(date);
  const status = routingStatus(access);
  let routes = buildRoutes(day.assignments, day.yard);
  const trucks = routes.map((r) => ({ id: r.truckId, unit: r.unit }));
  if (sp.truck) routes = routes.filter((r) => r.truckId === sp.truck);
  const usage = status.state === "ready" ? await addRoadEstimates(routes, status.provider) : null;
  const canEditSites = can(access, "customers.edit");
  const canEditYard = can(access, "settings.manage");
  const yardText = day.yard ? `${day.yard.lat}, ${day.yard.lng}` : "";

  return (
    <>
      <PageHeader
        title="Route Planner"
        description={`${formatDateLong(date)}. Each truck's day as a route: from the yard to every delivery site in load order and back, read from the dispatch board. Routes change only when the board does.`}
      />

      <form method="get" className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-card p-4" aria-label="Route settings">
        <label className="text-sm">
          <span className="mb-1 block font-semibold text-ink">Day</span>
          <DateInput name="date" defaultValue={date} min={addDays(today, -30)} max={addDays(today, 30)} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-semibold text-ink">Truck</span>
          <select name="truck" defaultValue={sp.truck ?? ""} className="h-10 rounded-md border border-line bg-card px-3 text-sm text-ink">
            <option value="">All trucks</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>Truck {t.unit}</option>)}
          </select>
        </label>
        <button className="h-10 rounded-md bg-action px-4 text-sm font-semibold text-white hover:opacity-90">Show routes</button>
      </form>

      {status.state !== "ready" ? (
        <Notice title="Straight-line distances">{status.reason} Straight lines are the shortest possible distance; trucks drive further.</Notice>
      ) : (
        <Notice title="Truck routing by HERE">
          Road distances and driving times use HERE&apos;s standard truck profile (truck dimensions are not recorded in Taviron yet). Notices are
          HERE&apos;s own; a route without notices is not a guarantee the road is clear — check closures and seasonal limits.
          {usage?.capped && " Some legs were not routed on this page: choose one truck to route the rest."}
        </Notice>
      )}

      {!day.yard && (
        <Card className="mt-5">
          <CardHeader title="Yard location" description="Routes start and end at the yard. Without it they begin at the first delivery." />
          <CardBody>
            {!day.installed ? (
              <p className="text-sm text-muted">The yard location needs a database update that has not been installed yet.</p>
            ) : canEditYard ? (
              <YardLocationForm current={yardText} canLookUp={status.state === "ready"} />
            ) : (
              <p className="text-sm text-muted">Someone with settings access can set it here or in Settings → Dispatch rules.</p>
            )}
          </CardBody>
        </Card>
      )}

      {day.unlocated.length > 0 && (
        <Card className="mt-5">
          <CardHeader title={`${day.unlocated.length} site${day.unlocated.length === 1 ? "" : "s"} without a location`} description="Legs to these sites have no distance until they are located. Coordinates can be copied from any map." />
          <ul className="divide-y divide-line">
            {day.unlocated.map((s) => (
              <li key={s.siteId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{s.label}</p>
                  <p className="truncate text-xs text-muted">{s.customer}{s.address ? ` · ${s.address}` : ""}</p>
                </div>
                {canEditSites ? <SiteLocationForm siteId={s.siteId} label={s.label} canLookUp={status.state === "ready"} /> : <span className="text-xs text-muted">Needs customer edit access</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {routes.length === 0 ? (
        <EmptyState
          className="mt-5"
          icon={<Route className="size-6" aria-hidden />}
          title="No assigned loads on this day"
          description={<>Routes appear once loads are assigned to trucks. <Link href={`/dispatch?date=${date}`} className="font-medium text-brand-fg hover:underline">Open the dispatch board</Link>.</>}
        />
      ) : (
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          {routes.map((r) => {
            const t = routeTotals(r);
            return (
              <section key={r.truckId} aria-label={`Route for truck ${r.unit}`}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
                  <div className="flex items-center gap-3">
                    <span className="grid size-9 place-items-center rounded-lg bg-surface text-ink"><Truck className="size-4" aria-hidden /></span>
                    <div>
                      <h2 className="font-semibold text-ink">Truck {r.unit}{r.trailer ? ` + ${r.trailer}` : ""}</h2>
                      <p className="text-xs text-muted">{r.driver} · {r.stops.length} load{r.stops.length === 1 ? "" : "s"}</p>
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    {t.roadMiles !== null ? (
                      <>
                        <p className="font-semibold tabular text-ink">{t.roadMiles} mi · {formatMinutes(t.roadMinutes!)}</p>
                        <p className="text-xs text-muted">Road, by HERE</p>
                      </>
                    ) : t.straightMiles !== null ? (
                      <>
                        <p className="font-semibold tabular text-ink">{t.straightMiles} mi</p>
                        <p className="text-xs text-muted">Straight line (estimate)</p>
                      </>
                    ) : (
                      <p className="text-xs text-muted">Distance unknown: a location is missing</p>
                    )}
                  </div>
                </div>
                <ol className="px-4 py-3 sm:px-5" aria-label="Stops and legs">
                  {r.legs.length === 0 && r.stops.map((s) => <StopRow key={s.loadId} label={`${s.orderNumber} · ${s.site}`} sub={`${s.customer} · ${s.start}–${s.end}`} located={Boolean(s.point)} />)}
                  {r.legs.map((l, i) => {
                    const stop = r.stops.find((s) => `${s.orderNumber} · ${s.site}` === l.to);
                    return (
                      <li key={i} className="relative">
                        {i === 0 && <StopRow label={l.from} sub={l.from === YARD ? "Start of the day" : undefined} located={Boolean(l.fromPoint)} />}
                        <div className="my-1 ml-[15px] border-l-2 border-dashed border-line py-1.5 pl-5 text-xs text-muted">
                          {l.road ? (
                            <span className="tabular">{l.road.miles} mi · {formatMinutes(l.road.minutes)}</span>
                          ) : l.straightMiles !== null ? (
                            <span className="tabular">{l.straightMiles} mi straight line</span>
                          ) : (
                            <span>No distance: a location is missing</span>
                          )}
                          {l.road?.notices.map((n) => <Badge key={n} tone="amber" className="ml-2">{n}</Badge>)}
                          {!l.road && l.roadMissing && status.state === "ready" && l.straightMiles !== null && <span className="ml-2">({l.roadMissing})</span>}
                        </div>
                        <StopRow label={l.to} sub={l.to === YARD ? "End of the day" : stop ? `${stop.customer} · ${stop.start}–${stop.end}${stop.locationSource === "here" ? " · location estimated from the address" : ""}` : undefined} located={Boolean(l.toPoint)} href={stop ? `/orders/${stop.orderId}` : undefined} />
                      </li>
                    );
                  })}
                </ol>
              </Card>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function StopRow({ label, sub, located, href }: { label: string; sub?: string; located: boolean; href?: string }) {
  const yard = label === YARD;
  return (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border ${yard ? "border-strong bg-strong text-white" : "border-line bg-card text-ink"}`}>
        <MapPin className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 pt-1">
        {href ? <Link href={href} className="font-medium text-ink hover:underline">{label}</Link> : <p className="font-medium text-ink">{label}</p>}
        {sub && <p className="text-xs text-muted">{sub}</p>}
        {!located && <p className="text-xs text-critical">Location missing</p>}
      </div>
    </div>
  );
}
