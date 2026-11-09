// Which loads each leg of a truck's route arrives at (B3), and their times in the app's 12-hour format. Pure: used by
// the Routes view on Dispatch and its unit tests.
import { formatTime } from "@/lib/orders/schedule";
import { PICKUP_PREFIX, YARD, type RouteStop, type TruckRoute } from "@/lib/routing/route";

/**
 * The loads reached at each leg's end, matched by position in the route, not by label (B3): two deliveries to the same
 * site share a label, and a label lookup gave the second one the first one's times. Rebuilds the route's stop sequence
 * the way buildRoutes lays it out (yard, then each load's pickup and site, then yard) and walks the legs through it;
 * stops merged into one (consecutive loads at the same point have no leg between them) are listed together.
 */
export function legArrivals(r: Pick<TruckRoute, "stops" | "legs">, hasYard: boolean): { from: RouteStop[]; to: RouteStop[][] } {
  const ends: Array<{ label: string; stop: RouteStop | null }> = [
    ...(hasYard ? [{ label: YARD, stop: null }] : []),
    ...r.stops.flatMap((s) => [...(s.pickup ? [{ label: `${PICKUP_PREFIX}${s.pickup.name}`, stop: null }] : []), { label: `${s.orderNumber} · ${s.site}`, stop: s }]),
    ...(hasYard ? [{ label: YARD, stop: null }] : []),
  ];
  const at: number[] = [];
  let p = 0;
  for (const l of r.legs) {
    let k = p + 1;
    while (k < ends.length && ends[k].label !== l.to) k++;
    at.push(k);
    p = k;
  }
  const stopsIn = (a: number, b: number) => ends.slice(a, b).flatMap((e) => (e.stop ? [e.stop] : []));
  return { from: stopsIn(0, at[0] ?? 0), to: at.map((k, i) => stopsIn(k, i + 1 < at.length ? at[i + 1] : ends.length)) };
}

/** "Harlow Homes · 1:00 PM–2:30 PM", or each load's times when several loads end at the same stop. */
export function stopTimes(stops: RouteStop[]): string | undefined {
  if (!stops.length) return undefined;
  const range = (s: RouteStop) => `${formatTime(s.start)}–${formatTime(s.end)}`;
  if (stops.length === 1) return `${stops[0].customer} · ${range(stops[0])}${stops[0].locationSource === "here" ? " · location estimated from the address" : ""}`;
  const one = stops.every((s) => s.orderNumber === stops[0].orderNumber);
  return `${stops[0].customer} · ${stops.map((s) => `${one ? "" : `${s.orderNumber} `}load ${s.loadNumber} ${range(s)}`).join(", ")}${stops.some((s) => s.locationSource === "here") ? " · location estimated from the address" : ""}`;
}
