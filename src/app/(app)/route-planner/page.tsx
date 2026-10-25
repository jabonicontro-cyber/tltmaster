import Link from "next/link";
import { MapPin, Route, Truck } from "lucide-react";
import { SiteLocationForm, YardLocationForm } from "@/components/routing/location-forms";
import { LocationsPanel } from "@/components/routing/locations-panel";
import { RouteBuilder } from "@/components/routing/route-builder";
import { RouteMap } from "@/components/routing/route-map";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { addDays, formatDateLong, isIsoDate } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { buildRoutes, formatMinutes, routeTotals, YARD } from "@/lib/routing/route";
import { requirePagePermission } from "@/server/auth";
import { listLocations, listSavedRoutes, listSiteOptions, listTruckOptions } from "@/server/data/route-planner";
import { getRouteDay } from "@/server/data/routes";
import { businessToday, getSettings } from "@/server/data/settings";
import { addRoadEstimates, routingStatus } from "@/server/routing/service";

export const metadata = { title: "Route Planner" };

type Search = { date?: string; truck?: string; view?: string; route?: string };

const VIEWS = [
  { key: "today", label: "Today's routes" },
  { key: "plan", label: "Plan a route" },
  { key: "locations", label: "Locations" },
] as const;

function ViewNav({ view }: { view: string }) {
  return (
    <nav aria-label="Route Planner views" className="mb-5 inline-flex flex-wrap gap-1 rounded-lg border border-line bg-card p-1">
      {VIEWS.map((v) => (
        <Link key={v.key} href={v.key === "today" ? "/route-planner" : `/route-planner?view=${v.key}`} aria-current={view === v.key ? "page" : undefined}
          className={`rounded-md px-3 py-1.5 text-sm font-semibold ${view === v.key ? "bg-strong text-white" : "text-muted hover:bg-surface hover:text-ink"}`}>
          {v.label}
        </Link>
      ))}
    </nav>
  );
}

export default async function RoutePlannerPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("dispatch.view");
  const sp = await searchParams;
  const view = sp.view === "plan" || sp.view === "locations" ? sp.view : "today";
  if (view !== "today") {
    const status = routingStatus(access);
    const ready = status.state === "ready";
    const [locs, sites, trucks, saved, settingsDay] = await Promise.all([
      listLocations(), listSiteOptions(), listTruckOptions(), listSavedRoutes(), getSettings(),
    ]);
    const ys = settingsDay as unknown as { yard_latitude?: number | string | null; yard_longitude?: number | string | null };
    const yard = ys.yard_latitude != null && ys.yard_longitude != null ? { lat: Number(ys.yard_latitude), lng: Number(ys.yard_longitude) } : null;
    return (
      <>
        <PageHeader title="Route Planner" description="Plan truck routes between your yards, quarries and job sites, and keep the places your trucks use. Plans here never assign a load." />
        <ViewNav view={view} />
        {!ready && <div className="mb-5"><Notice title="Straight-line distances">{status.reason.replace(" Distances below are straight lines.", "")} Routes show straight-line distances and no driving time until then; address search and map backgrounds need it too.</Notice></div>}
        {!locs.installed ? (
          <Notice tone="warning" title="Saved locations are not installed yet">This part of the Route Planner needs a database update that has not been applied yet.</Notice>
        ) : view === "plan" ? (
          <RouteBuilder locations={locs.locations} sites={sites} trucks={trucks.trucks} saved={saved} initialRouteId={sp.route ?? null} canEdit={can(access, "dispatch.edit")} routingReady={ready} tiles={ready} />
        ) : (
          <LocationsPanel locations={locs.locations} canEdit={can(access, "dispatch.edit") || can(access, "settings.manage")} canSetYard={can(access, "settings.manage")} routingReady={ready} tiles={ready} yard={yard} />
        )}
      </>
    );
  }
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
      <ViewNav view="today" />

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
              <p className="text-sm text-muted">Someone with settings access can set it on this page.</p>
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
                {r.legs.some((l) => l.fromPoint && l.toPoint) && (
                  <div className="px-4 pt-3 sm:px-5">
                    <RouteMap
                      stops={[...(r.legs[0]?.fromPoint ? [{ point: r.legs[0].fromPoint, label: r.legs[0].from }] : []), ...r.legs.filter((l) => l.toPoint).map((l) => ({ point: l.toPoint!, label: l.to }))]}
                      tiles={status.state === "ready"}
                      title={`Map of truck ${r.unit}'s route`}
                    />
                  </div>
                )}
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
