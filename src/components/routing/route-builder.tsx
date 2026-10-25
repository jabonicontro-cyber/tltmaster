"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Route as RouteIcon, X } from "lucide-react";
import { toast } from "sonner";
import { archiveRoute, planRoute, saveRoute, type PlanResult } from "@/app/(app)/route-planner/builder-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select } from "@/components/ui/form";
import { MAX_ROUTE_STOPS, formatMinutes, hasVehicleProfile, type Point } from "@/lib/routing/route";
import type { CompanyLocation, SavedRoute, SiteOption, TruckOption } from "@/lib/routing/locations";
import { AddressSearch } from "./address-search";
import { RouteMap } from "./route-map";

type Stop =
  | { key: string; kind: "location" | "site"; id: string; label: string; point: Point | null; serviceMinutes: number }
  | { key: string; kind: "point"; label: string; point: Point; serviceMinutes: number };

let seq = 0;
const nextKey = () => `s${++seq}`;

function toRef(s: Stop) {
  return s.kind === "point"
    ? { kind: "point" as const, lat: s.point.lat, lng: s.point.lng, label: s.label, serviceMinutes: s.serviceMinutes }
    : { kind: s.kind, id: s.id, serviceMinutes: s.serviceMinutes };
}

function fromSaved(r: SavedRoute, locations: CompanyLocation[], sites: SiteOption[]): Stop[] {
  return r.stops.map((s) => {
    if (s.kind === "point" && s.point) return { key: nextKey(), kind: "point", label: s.label, point: s.point, serviceMinutes: s.serviceMinutes };
    const place = s.kind === "location" ? locations.find((l) => l.id === s.id) : sites.find((x) => x.id === s.id);
    return { key: nextKey(), kind: s.kind === "location" ? "location" : "site", id: s.id!, label: place ? ("name" in place ? place.name : place.label) : s.label, point: place?.point ?? null, serviceMinutes: s.serviceMinutes };
  });
}

/**
 * Build a route: places from saved locations, customer sites, an address search or coordinates; a truck whose recorded
 * dimensions go to the routing provider; time at each stop. Calculates on the server; nothing is assigned or sent.
 */
export function RouteBuilder({
  locations, sites, trucks, saved, initialRouteId, canEdit, routingReady, tiles,
}: {
  locations: CompanyLocation[];
  sites: SiteOption[];
  trucks: TruckOption[];
  saved: SavedRoute[];
  initialRouteId: string | null;
  canEdit: boolean;
  routingReady: boolean;
  tiles: boolean;
}) {
  const router = useRouter();
  const initial = saved.find((r) => r.id === initialRouteId) ?? null;
  const [stops, setStops] = useState<Stop[]>(() => (initial ? fromSaved(initial, locations, sites) : []));
  const [truckId, setTruckId] = useState<string>(initial?.truckId ?? "");
  const [returnToStart, setReturnToStart] = useState(false);
  const [alternatives, setAlternatives] = useState(false);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [routeIndex, setRouteIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [routeId, setRouteId] = useState<string | null>(initial?.id ?? null);
  const [pick, setPick] = useState("");
  const [pending, start] = useTransition();
  const truck = trucks.find((t) => t.id === truckId) ?? null;

  const change = (next: Stop[]) => {
    setStops(next);
    setResult(null);
  };
  const add = (s: Stop) => {
    if (stops.length >= MAX_ROUTE_STOPS) return toast.error(`A route has at most ${MAX_ROUTE_STOPS} places.`);
    change([...stops, s]);
  };
  const move = (i: number, by: number) => {
    const next = [...stops];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s);
    change(next);
  };

  const refs = () => {
    const list = stops.map(toRef);
    return returnToStart && stops.length ? [...list, { ...toRef(stops[0]), serviceMinutes: 0 }] : list;
  };

  const calculate = (optimize: boolean) =>
    start(async () => {
      setError(null);
      const r = await planRoute({ stops: refs(), truckId: truckId || null, alternatives: alternatives && stops.length === 2 && !returnToStart, optimize, fixedEnd: returnToStart });
      if (!r.ok) {
        setError(r.error);
        setResult(null);
        return;
      }
      setRouteIndex(0);
      setResult(r.data);
      if (r.data.reordered) {
        // Apply the suggested order to the list (the copy of the first stop at the end stays implicit).
        const order = r.data.reordered.filter((i) => i < stops.length);
        change(order.map((i) => stops[i]));
        setResult(r.data);
        toast.success("Stops reordered for a shorter route. Check the order before using it.");
      }
    });

  const save = () =>
    start(async () => {
      const r = await saveRoute({ id: routeId ?? undefined, name, truckId: truckId || null, stops: stops.map(toRef) });
      if (!r.ok) return void toast.error(r.error);
      setRouteId(r.data.id);
      toast.success(r.message ?? "Route saved.");
      router.refresh();
    });

  const route = result?.routes?.[routeIndex] ?? null;
  const mapStops = useMemo(() => (result ? result.stops : stops).filter((s) => s.point).map((s) => ({ point: s.point!, label: s.label })), [result, stops]);
  const missing = stops.filter((s) => !s.point);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <section aria-labelledby="stops-title" className="space-y-4">
        <div className="rounded-panel border border-line/70 bg-card shadow-card p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 id="stops-title" className="font-semibold text-ink">Stops</h2>
            {saved.length > 0 && (
              <Select aria-label="Open a saved route" className="h-9 w-48" value="" onChange={(e) => { const r = saved.find((x) => x.id === e.target.value); if (r) { change(fromSaved(r, locations, sites)); setName(r.name); setRouteId(r.id); setTruckId(r.truckId ?? ""); } }}>
                <option value="">Open a saved route…</option>
                {saved.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            )}
          </div>
          {stops.length === 0 ? (
            <p className="text-sm text-muted">Add the first place below: usually the yard or the quarry.</p>
          ) : (
            <ol className="space-y-2" aria-label="Stops in order">
              {stops.map((s, i) => (
                <li key={s.key} className="flex items-start gap-2 rounded-xl border border-line bg-surface p-2">
                  <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-strong text-xs font-bold text-white">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{s.label}</p>
                    <p className="text-xs text-muted">{s.kind === "location" ? "Saved location" : s.kind === "site" ? "Customer site" : "Typed place"}{!s.point && <span className="text-critical"> · no location yet</span>}</p>
                    <label className="mt-1 flex items-center gap-2 text-xs text-muted">
                      Minutes at stop
                      <Input type="number" min={0} max={600} value={s.serviceMinutes} onChange={(e) => change(stops.map((x) => (x.key === s.key ? { ...x, serviceMinutes: Math.max(0, Math.min(600, Number(e.target.value) || 0)) } : x)))} className="h-7 w-20 px-2 text-xs" aria-label={`Minutes at ${s.label}`} />
                    </label>
                  </div>
                  <div className="flex shrink-0 flex-col">
                    <Button size="sm" variant="ghost" className="h-7 px-1.5" aria-label={`Move ${s.label} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" aria-hidden /></Button>
                    <Button size="sm" variant="ghost" className="h-7 px-1.5" aria-label={`Move ${s.label} down`} disabled={i === stops.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" aria-hidden /></Button>
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 px-1.5" aria-label={`Remove ${s.label}`} onClick={() => change(stops.filter((x) => x.key !== s.key))}><X className="size-4" aria-hidden /></Button>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="space-y-3 rounded-panel border border-line/70 bg-card shadow-card p-4">
          <h3 className="text-sm font-semibold text-ink">Add a place</h3>
          <Select aria-label="Saved location or customer site" value={pick} onChange={(e) => {
            const [kind, id] = e.target.value.split(":");
            setPick("");
            if (kind === "location") { const l = locations.find((x) => x.id === id); if (l) add({ key: nextKey(), kind: "location", id: l.id, label: l.name, point: l.point, serviceMinutes: 0 }); }
            if (kind === "site") { const s = sites.find((x) => x.id === id); if (s) add({ key: nextKey(), kind: "site", id: s.id, label: s.label, point: s.point, serviceMinutes: 0 }); }
          }}>
            <option value="">Choose a saved location or customer site…</option>
            {locations.length > 0 && (
              <optgroup label="Saved locations">
                {locations.map((l) => <option key={l.id} value={`location:${l.id}`}>{l.name}{l.point ? "" : " (no location yet)"}</option>)}
              </optgroup>
            )}
            {sites.length > 0 && (
              <optgroup label="Customer sites">
                {sites.map((s) => <option key={s.id} value={`site:${s.id}`}>{s.label}{s.customer ? ` · ${s.customer}` : ""}{s.point ? "" : " (no location yet)"}</option>)}
              </optgroup>
            )}
          </Select>
          <AddressSearch routingReady={routingReady} tiles={tiles} pickLabel="Add to route" onPick={(p) => add({ key: nextKey(), kind: "point", label: p.label, point: p.point, serviceMinutes: 0 })} />
        </div>

        <div className="space-y-3 rounded-panel border border-line/70 bg-card shadow-card p-4">
          <Field label="Truck" htmlFor="route-truck" hint={truck ? (hasVehicleProfile(truck.vehicle) ? "Its recorded height, width, length, weight and axles go to the routing provider." : "This truck has no recorded dimensions: the provider's standard truck is used.") : "Without a truck, the provider's standard truck is used."}>
            <Select id="route-truck" value={truckId} onChange={(e) => { setTruckId(e.target.value); setResult(null); }}>
              <option value="">No specific truck</option>
              {trucks.map((t) => <option key={t.id} value={t.id}>Truck {t.unit}{hasVehicleProfile(t.vehicle) ? "" : " (no dimensions)"}</option>)}
            </Select>
          </Field>
          <Checkbox label="Return to the first stop" checked={returnToStart} onChange={(e) => { setReturnToStart(e.target.checked); setResult(null); }} />
          <Checkbox label="Show alternative routes (two places only)" checked={alternatives} disabled={stops.length !== 2 || returnToStart} onChange={(e) => { setAlternatives(e.target.checked); setResult(null); }} />
          <div className="flex flex-wrap gap-2 pt-1">
            <Button loading={pending} disabled={stops.length < 2 || missing.length > 0} onClick={() => calculate(false)}>Calculate route</Button>
            <Button variant="secondary" disabled={pending || stops.length < 4 || missing.length > 0} onClick={() => calculate(true)} title="Keeps the first stop (and the return) in place">Suggest a shorter order</Button>
          </div>
          {missing.length > 0 && <p className="text-sm text-critical">Locate {missing.map((m) => m.label).join(", ")} first (Locations, or the customer site).</p>}
          {error && <p role="alert" className="text-sm text-critical">{error}</p>}
          {canEdit && stops.length >= 2 && (
            <form className="flex flex-wrap gap-2 border-t border-line pt-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
              <Input aria-label="Route name" placeholder="Route name, e.g. Quarry → Cedar Ridge" value={name} onChange={(e) => setName(e.target.value)} className="h-10 min-w-0 basis-full" maxLength={120} />
              <Button type="submit" variant="secondary" disabled={pending || !name.trim()}>{routeId ? "Update saved route" : "Save route"}</Button>
              {routeId && <Button variant="ghost" disabled={pending} onClick={() => start(async () => { const r = await archiveRoute({ id: routeId }); if (r.ok) { toast.success(r.message ?? "Archived."); setRouteId(null); router.refresh(); } else toast.error(r.error); })}>Archive</Button>}
            </form>
          )}
        </div>
      </section>

      <section aria-labelledby="result-title" className="min-w-0 space-y-4">
        <h2 id="result-title" className="sr-only">Route</h2>
        {mapStops.length > 0 ? <RouteMap stops={mapStops} line={route?.line ?? []} tiles={tiles} title="Route map" /> : (
          <div className="grid aspect-video place-items-center rounded-2xl border border-dashed border-line bg-card p-6 text-center text-sm text-muted">
            <div><RouteIcon className="mx-auto mb-2 size-6" aria-hidden />Add two or more places to see the route.</div>
          </div>
        )}
        {result && <RouteSummary result={result} route={route} routeIndex={routeIndex} setRouteIndex={setRouteIndex} />}
      </section>
    </div>
  );
}

function RouteSummary({ result, route, routeIndex, setRouteIndex }: { result: PlanResult; route: PlanResult["routes"] extends (infer R)[] | null ? R | null : never; routeIndex: number; setRouteIndex: (i: number) => void }) {
  const critical = route?.notices.filter((n) => n.severity === "critical") ?? [];
  const info = route?.notices.filter((n) => n.severity === "info") ?? [];
  return (
    <div className="space-y-3 rounded-panel border border-line/70 bg-card shadow-card p-4">
      {result.routes && result.routes.length > 1 && (
        <div role="tablist" aria-label="Route options" className="flex flex-wrap gap-2">
          {result.routes.map((r, i) => (
            <button key={i} role="tab" aria-selected={i === routeIndex} onClick={() => setRouteIndex(i)} className={`rounded-xl border px-3 py-1.5 text-sm ${i === routeIndex ? "border-strong bg-strong text-white" : "border-line bg-card text-ink hover:bg-surface"}`}>
              {i === 0 ? "Provider's choice" : `Alternative ${i}`} · {r.miles} mi · {formatMinutes(r.minutes)}
            </button>
          ))}
        </div>
      )}
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">Distance</dt>
          <dd className="text-lg font-semibold tabular text-ink">{route ? `${route.miles} mi` : `${result.straightTotal} mi`}</dd>
          <dd className="text-xs text-muted">{route ? "Road, truck routing by HERE" : "Straight lines (the shortest possible; roads are longer)"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Driving time</dt>
          <dd className="text-lg font-semibold tabular text-ink">{route ? formatMinutes(route.minutes) : "Not available"}</dd>
          <dd className="text-xs text-muted">{route ? "Provider estimate, typical traffic; not live traffic" : "Needs road routing; no speed is assumed"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Time at stops</dt>
          <dd className="text-lg font-semibold tabular text-ink">{formatMinutes(result.serviceMinutes)}</dd>
          <dd className="text-xs text-muted">{route ? `Total ${formatMinutes(route.minutes + result.serviceMinutes)} with driving` : "As entered for each stop"}</dd>
        </div>
      </dl>
      {result.truck && (
        <p className="text-sm text-muted">Truck {result.truck.unit}: {result.truck.profileUsed ? "its recorded dimensions were sent to the routing provider." : "no dimensions recorded, so the provider's standard truck was used."}</p>
      )}
      {result.roadMissing && <p className="text-sm text-muted">Road routing: {result.roadMissing}</p>}
      {critical.length > 0 && (
        <div role="alert" className="rounded-xl border border-critical/40 bg-critical/5 p-3 text-sm text-critical">
          <p className="font-semibold">The provider reports restrictions this route could not avoid:</p>
          <ul className="mt-1 list-disc pl-5">{critical.map((n) => <li key={n.text}>{n.text}</li>)}</ul>
        </div>
      )}
      {info.length > 0 && <div className="flex flex-wrap gap-2">{info.map((n) => <Badge key={n.text} tone="amber">{n.text}</Badge>)}</div>}
      <p className="text-xs text-muted">Restrictions come from the routing provider&apos;s data and Taviron has not verified them. A route without notices is not a guarantee it is legal or clear: check posted limits, closures and seasonal weight restrictions.</p>
      <ol className="divide-y divide-line text-sm" aria-label="Legs">
        {result.stops.slice(1).map((s, i) => (
          <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
            <span className="text-ink">{i + 1}. {result.stops[i].label} → {s.label}</span>
            <span className="tabular text-muted">
              {route?.legs[i] ? `${route.legs[i].miles} mi · ${formatMinutes(route.legs[i].minutes)}` : `${result.straightMiles[i]} mi straight line`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
