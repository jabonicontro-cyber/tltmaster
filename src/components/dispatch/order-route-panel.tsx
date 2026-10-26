"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Loader2, MapPin, Navigation, Truck, X } from "lucide-react";
import { RouteMap } from "@/components/routing/route-map";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatMinutes, YARD } from "@/lib/routing/route";
import { orderRoute } from "@/app/(app)/dispatch/route-actions";
import type { OrderRoute, RouteLine } from "@/server/data/order-route";

/**
 * The order's route beside the board (owner 2026-10-26: Dispatch and the Route Planner on one page). Opens when an
 * order is clicked: the suggested trip from the yard to the job site and back (what each open load takes), and the
 * day of every truck already carrying the order. Read only; assigning stays on the board.
 */
export function OrderRoutePanel({ orderId, date, onClose, inline = false }: { orderId: string; date: string; onClose: () => void; /** Beside the board on wide screens (sticky in its column) instead of floating. */ inline?: boolean }) {
  const [state, setState] = useState<{ id: string; data: OrderRoute | null; error: string | null } | null>(null);
  const loading = state?.id !== orderId;

  useEffect(() => {
    let live = true;
    void orderRoute({ orderId, date }).then((r) => {
      if (live) setState({ id: orderId, data: r.ok ? r.data : null, error: r.ok ? null : r.error });
    });
    return () => {
      live = false;
    };
  }, [orderId, date]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const r = loading ? null : state?.data ?? null;
  return (
    <aside
      aria-label="Order route"
      className={cn(
        "ui-pop fixed inset-x-3 bottom-3 z-40 flex max-h-[85dvh] flex-col overflow-hidden rounded-[1.5rem] border border-line/70 bg-card shadow-float md:inset-x-auto md:top-3 md:right-3 md:max-h-none md:w-[30rem]",
        inline && "xl:sticky xl:top-4 xl:z-auto xl:max-h-[calc(100dvh-2rem)] xl:w-auto",
      )}
    >
      <header className="flex items-start gap-3 border-b border-line/70 px-5 py-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-surface text-ink"><Navigation className="size-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-ink">{r ? `Order ${r.orderNumber}` : "Order route"}</h2>
          {r && <p className="truncate text-sm text-muted">{r.customer} · {r.site}</p>}
        </div>
        <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-full text-muted hover:bg-surface hover:text-ink" aria-label="Close the route">
          <X className="size-5" aria-hidden />
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="size-4 animate-spin" aria-hidden /> Working out the route…</p>
        ) : !r ? (
          <p role="alert" className="text-sm text-critical">{state?.error ?? "The route could not be loaded."}</p>
        ) : (
          <>
            <dl className="grid grid-cols-3 gap-2">
              <Stat label="Open loads" value={String(r.openLoads)} tone={r.openLoads ? "warn" : undefined} />
              <Stat label="Assigned" value={String(r.assignedLoads)} />
              <Stat label="To the site" value={driveTotal(r) !== null ? `${driveTotal(r)} mi` : "—"} />
            </dl>

            {!r.routing.ready && <p className="rounded-2xl bg-surface px-3 py-2 text-xs text-muted">{r.routing.reason}</p>}

            <section aria-label="Suggested route">
              <h3 className="text-sm font-semibold text-ink">Suggested route for each load</h3>
              <p className="mb-3 text-xs text-muted">Each drive starts where the truck is: at the yard for its first load of the day, then wherever its previous delivery left it.</p>
              {r.loads.length === 0 ? (
                <p className="text-sm text-muted">No loads of this order on this day yet.</p>
              ) : (
                <ol className="space-y-3" aria-label="Loads">
                  {r.loads.map((l) => (
                    <li key={l.loadId} aria-label={`Load ${l.loadNumber}`} className="rounded-2xl border border-line/70 p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-semibold text-ink">Load {l.loadNumber}</span>
                        <span className="tabular text-muted">{l.start}–{l.end}</span>
                        {l.truck ? <span className="text-muted">· Truck {l.truck}{l.driver ? `, ${l.driver}` : ""}</span> : <Badge tone="amber">Needs a truck</Badge>}
                      </div>
                      <p className="mb-2 text-xs text-muted">
                        {l.from === "previous" ? "From the previous delivery" : l.from === "base" ? "Start of the day, from the yard" : "From the yard until a truck is assigned; then from where that truck's previous delivery left it"}
                      </p>
                      <RouteCard route={l.route} tiles={r.routing.ready} title={`Load ${l.loadNumber}'s drive`} compact map={r.loads.length <= 4} />
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {r.trucks.length > 0 && (
              <section aria-label="Trucks on this order">
                <h3 className="mb-2 text-sm font-semibold text-ink">Each truck&apos;s whole day</h3>
                <div className="space-y-3">
                  {r.trucks.map((t) => (
                    <div key={t.unit} className="rounded-2xl border border-line/70 p-3">
                      <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><Truck className="size-4" aria-hidden /> Truck {t.unit} <span className="font-normal text-muted">· {t.driver}</span></p>
                      <RouteCard route={t.route} tiles={r.routing.ready} title={`Truck ${t.unit}'s day`} compact />
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-line/70 px-5 py-3">
        <Link href={`/orders/${orderId}`} className="inline-flex items-center gap-1 text-sm font-semibold text-ink hover:underline">
          Open the order <ArrowUpRight className="size-4" aria-hidden />
        </Link>
      </footer>
    </aside>
  );
}

/** Miles to the site over the day's loads, when every one is known. */
function driveTotal(r: OrderRoute): number | null {
  if (!r.loads.length || r.loads.some((l) => l.route.miles === null)) return null;
  return Math.round(r.loads.reduce((n, l) => n + (l.route.miles ?? 0), 0) * 10) / 10;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className="rounded-2xl bg-surface px-3 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-lg font-semibold tabular text-ink", tone === "warn" && "text-amber-800")}>{value}</dd>
    </div>
  );
}

function RouteCard({ route, tiles, title, compact = false, map = true }: { route: RouteLine; tiles: boolean; title: string; compact?: boolean; /** Off for long days, to keep the panel light. */ map?: boolean }) {
  const points = route.stops.filter((s) => s.point);
  // A map needs two different places (a trip from the yard to a site without a location is the yard twice).
  const places = new Set(points.map((s) => `${s.point!.lat},${s.point!.lng}`));
  return (
    <div className="space-y-3">
      {map && places.size >= 2 && (
        <div className="overflow-hidden rounded-2xl">
          <RouteMap stops={points.map((s) => ({ point: s.point!, label: s.label }))} line={route.line} tiles={tiles} title={title} />
        </div>
      )}
      <p className="text-sm">
        {route.miles !== null ? (
          <>
            <span className="font-semibold tabular text-ink">{route.miles} mi{route.minutes !== null ? ` · ${formatMinutes(route.minutes)} driving` : ""}</span>
            <span className="text-muted"> · {route.basis === "road" ? "truck routing by HERE" : "straight line (estimate)"}</span>
          </>
        ) : (
          <span className="text-muted">{route.missing}</span>
        )}
      </p>
      {route.missing && route.miles !== null && <p className="text-xs text-muted">{route.missing}</p>}
      {route.notices.length > 0 && <div className="flex flex-wrap gap-1.5">{route.notices.map((n) => <Badge key={n} tone="amber">{n}</Badge>)}</div>}
      {!compact || route.stops.length <= 6 ? (
        <ol className="space-y-2" aria-label="Stops">
          {route.stops.map((s, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold", s.label === YARD ? "border-strong bg-strong text-white" : s.thisOrder ? "border-brand/40 bg-brand-light text-brand-fg" : "border-line bg-card text-ink")}>
                {s.label === YARD ? <MapPin className="size-3" aria-hidden /> : i}
              </span>
              <span className="min-w-0">
                <span className={cn("block truncate", s.thisOrder ? "font-semibold text-ink" : "text-ink")}>{s.label}</span>
                {(s.start || !s.point) && <span className="block text-xs text-muted">{s.start ? `${s.start}–${s.end}` : ""}{!s.point ? `${s.start ? " · " : ""}Location missing` : ""}</span>}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
