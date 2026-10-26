"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Truck } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { shiftDate } from "@/lib/dispatch/board";
import { formatTime } from "@/lib/orders/schedule";
import type { DispatchDay, OrderLoadRow } from "@/server/data/dispatch";
import type { Face } from "@/server/data/faces";
import { OrderRoutePanel } from "./order-route-panel";

/**
 * The day as a timeline (owner 2026-10-26, from the dispatch console reference): one row per truck, its loads as
 * bars across the hours, and the loads still waiting for a truck on top. Clicking a bar opens the order's route
 * beside it. Read only: assigning stays on the board, through assign_load.
 */
export function DispatchTimeline({ day, faces = {}, urgentOrderIds = [], nowMinutes = null }: { day: DispatchDay; faces?: Record<string, Face>; urgentOrderIds?: string[]; /** Minutes since midnight in business time when the day is today. */ nowMinutes?: number | null }) {
  const [routeOrder, setRouteOrder] = useState<string | null>(null);
  const close = useCallback(() => setRouteOrder(null), []);

  const planned = day.loads.filter((l) => l.status !== "canceled");
  const active = day.assignments.filter((a) => a.status === "active");
  const byLoad = new Map(active.map((a) => [a.load_id, a]));
  const orders = new Map(day.orders.map((o) => [o.id, o]));
  const drivers = new Map(day.drivers.map((d) => [d.id, d.display_name]));
  const trailers = new Map(day.trailers.map((t) => [t.id, t.unit_number]));
  const open = planned.filter((l) => !byLoad.has(l.id));

  const rows = useMemo(() => {
    const loadsByTruck = new Map<string, OrderLoadRow[]>();
    for (const l of planned) {
      const a = byLoad.get(l.id);
      if (a) loadsByTruck.set(a.truck_id, [...(loadsByTruck.get(a.truck_id) ?? []), l]);
    }
    return day.trucks
      .map((t) => ({ truck: t, loads: loadsByTruck.get(t.id) ?? [] }))
      .sort((a, b) => Number(b.loads.length > 0) - Number(a.loads.length > 0) || a.truck.unit_number.localeCompare(b.truck.unit_number, undefined, { numeric: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const starts = planned.map((l) => minutes(l.start_time));
  const ends = planned.map((l) => minutes(l.end_time));
  // The hours the day's loads use, an hour either side, at least eight hours wide (6 AM to 6 PM on an empty day).
  let from = starts.length ? Math.max(0, Math.floor(Math.min(...starts) / 60) * 60 - 60) : 6 * 60;
  let to = ends.length ? Math.min(24 * 60, Math.ceil(Math.max(...ends) / 60) * 60 + 60) : 18 * 60;
  if (to - from < 8 * 60) {
    const grow = 8 * 60 - (to - from);
    from = Math.max(0, from - Math.floor(grow / 120) * 60);
    to = Math.min(24 * 60, from + 8 * 60 > to ? from + 8 * 60 : to);
  }
  const span = to - from;
  const hours = Array.from({ length: span / 60 + 1 }, (_, i) => from / 60 + i);
  const pos = (l: OrderLoadRow) => {
    const s = minutes(l.start_time);
    const e = Math.max(minutes(l.end_time), s + 15);
    return { left: `${((s - from) / span) * 100}%`, width: `${((e - s) / span) * 100}%` };
  };
  const now = nowMinutes !== null && nowMinutes >= from && nowMinutes <= to ? `${((nowMinutes - from) / span) * 100}%` : null;
  const dayHref = (d: string) => `/dispatch?view=timeline&date=${d}${day.base ? `&base=${day.base}` : ""}`;

  const bar = (l: OrderLoadRow, tone: "assigned" | "open") => {
    const o = orders.get(l.order_id);
    const urgent = urgentOrderIds.includes(l.order_id);
    const site = o ? o.site_label || o.site_line1 || o.site_city : "";
    const label = `${o?.order_number ?? "Order"} load ${l.load_number}, ${formatTime(l.start_time)} to ${formatTime(l.end_time)}${site ? `, ${site}` : ""}${tone === "open" ? ", needs a truck" : ""}`;
    return (
      <button
        key={l.id}
        type="button"
        onClick={() => setRouteOrder(l.order_id)}
        aria-label={label}
        title={label}
        style={pos(l)}
        className={cn(
          "absolute inset-y-1.5 flex min-w-0 flex-col justify-center overflow-hidden rounded-xl border px-2 text-left text-xs transition-[filter,transform] hover:brightness-95 active:scale-[0.98]",
          tone === "open" ? "border-dashed border-amber-400 bg-amber-50 text-amber-950" : "border-line bg-surface text-ink",
          urgent && "border-critical shadow-[0_0_0_2px_rgb(220_38_38/0.25)]",
          routeOrder === l.order_id && "ring-2 ring-strong",
        )}
      >
        <span className="truncate font-semibold tabular">{o?.order_number ?? "Order"} · {l.load_number}</span>
        <span className="truncate text-[11px] opacity-75">{formatTime(l.start_time)}{site ? ` · ${site}` : ""}</span>
      </button>
    );
  };

  const grid = (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {hours.slice(1, -1).map((h) => (
        <span key={h} className="absolute inset-y-0 border-l border-line/60" style={{ left: `${((h * 60 - from) / span) * 100}%` }} />
      ))}
      {now && <span className="absolute inset-y-0 w-0.5 bg-critical/70" style={{ left: now }} />}
    </div>
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Change day" className="flex flex-wrap items-center gap-2">
          <Link href={dayHref(shiftDate(day.date, -1))} className={buttonClasses("secondary", "sm")}><ChevronLeft className="size-4" aria-hidden /> Prev<span className="sr-only">ious day</span></Link>
          <Link href={dayHref(day.today)} className={buttonClasses(day.date === day.today ? "dark" : "secondary", "sm")}>Today</Link>
          <Link href={dayHref(shiftDate(day.date, 1))} className={buttonClasses("secondary", "sm")}>Next<span className="sr-only"> day</span> <ChevronRight className="size-4" aria-hidden /></Link>
        </nav>
        <p className="text-sm text-muted">Select a load to see its order&apos;s route. Assign on the <Link href={`/dispatch?date=${day.date}`} className="font-semibold text-ink hover:underline">Board</Link>.</p>
      </div>

      {planned.length === 0 && day.trucks.length === 0 ? (
        <EmptyState icon={<Truck className="size-6" />} title="Nothing to show for this day" description="Trucks and loads appear here once the fleet is set up and orders have loads." />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line/70 bg-card shadow-card">
          <div className="min-w-[56rem]" role="table" aria-label="Trucks by hour">
            <div role="row" className="sticky top-0 z-10 flex border-b border-line/70 bg-card">
              <div role="columnheader" className="w-56 shrink-0 px-4 py-2.5 text-xs font-semibold text-muted">Truck and driver</div>
              <div role="columnheader" className="relative h-10 flex-1">
                {hours.map((h, i) => (
                  <span key={h} className={cn("absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-semibold text-muted tabular", i === 0 ? "pl-1" : i === hours.length - 1 ? "-translate-x-full pr-1" : "-translate-x-1/2")} style={{ left: `${((h * 60 - from) / span) * 100}%` }}>
                    {h % 12 === 0 ? 12 : h % 12} {h % 24 < 12 ? "AM" : "PM"}
                  </span>
                ))}
              </div>
            </div>

            {open.length > 0 && (
              <div role="row" className="flex border-b border-line/70 bg-amber-50/40">
                <div role="rowheader" className="flex w-56 shrink-0 items-center gap-2 px-4 py-2">
                  <span className="grid size-8 place-items-center rounded-full bg-amber-100 text-amber-900"><Truck className="size-4" aria-hidden /></span>
                  <span>
                    <span className="block text-sm font-semibold text-ink">Needs a truck</span>
                    <span className="block text-xs text-muted">{open.length} load{open.length === 1 ? "" : "s"}</span>
                  </span>
                </div>
                <div role="cell" className="relative flex-1" style={{ height: `${Math.max(1, lanes(open, minutes)) * 3.25 + 0.5}rem` }}>
                  {grid}
                  {placeInLanes(open, minutes).map(({ load, lane }) => (
                    <div key={load.id} className="absolute inset-x-0" style={{ top: `${lane * 3.25 + 0.25}rem`, height: "3.25rem" }}>{bar(load, "open")}</div>
                  ))}
                </div>
              </div>
            )}

            {rows.map(({ truck, loads }) => {
              const first = loads[0] ? byLoad.get(loads[0].id) : null;
              const driverId = first?.driver_id ?? null;
              const driver = driverId ? drivers.get(driverId) ?? "" : "";
              const trailer = first?.trailer_id ? trailers.get(first.trailer_id) : null;
              const out = truck.service_status === "out_of_service";
              return (
                <div key={truck.id} role="row" className="flex border-b border-line/50 last:border-b-0">
                  <div role="rowheader" className="flex w-56 shrink-0 items-center gap-2.5 px-4 py-2">
                    {driverId ? <Avatar name={driver} src={faces[driverId]?.src} fallbackSrc={faces[driverId]?.fallbackSrc} size={32} /> : <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface text-muted"><Truck className="size-4" aria-hidden /></span>}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">Truck {truck.unit_number}{trailer ? <span className="font-normal text-muted"> + {trailer}</span> : null}</span>
                      <span className="block truncate text-xs text-muted">{out ? "Out of service" : driver || (loads.length ? "" : "Free all day")}</span>
                    </span>
                  </div>
                  <div role="cell" className="relative h-14 flex-1">
                    {grid}
                    {out && <Badge tone="gray" className="absolute top-1/2 left-2 -translate-y-1/2">Out of service</Badge>}
                    {loads.map((l) => bar(l, "assigned"))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {routeOrder && <OrderRoutePanel orderId={routeOrder} date={day.date} onClose={close} />}
    </>
  );
}

/** Greedy lanes so overlapping open loads do not cover each other. */
function placeInLanes(loads: OrderLoadRow[], minutes: (t: string) => number) {
  const laneEnds: number[] = [];
  return [...loads]
    .sort((a, b) => minutes(a.start_time) - minutes(b.start_time))
    .map((load) => {
      const s = minutes(load.start_time);
      let lane = laneEnds.findIndex((e) => e <= s);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = Math.max(minutes(load.end_time), s + 15);
      return { load, lane };
    });
}

function lanes(loads: OrderLoadRow[], minutes: (t: string) => number) {
  return placeInLanes(loads, minutes).reduce((n, p) => Math.max(n, p.lane + 1), 0);
}
