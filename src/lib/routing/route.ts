// Route planner (B10, first slice; owner 2026-10-14). Pure functions: a day's assigned loads become one route per truck
// — yard, then each delivery site in load order, then back to the yard — split into legs. Each leg carries the
// straight-line distance (always available, labelled as an estimate) and, when the truck-routing provider answered,
// the road distance, driving time and the provider's restriction notices. Nothing here calls a provider or changes a
// load: stop order is the dispatch board's own (start time), and routes are read-only.

export interface Point {
  lat: number;
  lng: number;
}

export interface RouteStop {
  loadId: string;
  orderId: string;
  orderNumber: string;
  loadNumber: number;
  customer: string;
  site: string;
  address: string;
  siteId: string | null;
  /** "HH:MM" business time. */
  start: string;
  end: string;
  point: Point | null;
  /** 'manual' (typed), 'here' (geocoded: an estimate of the address) or '' (none). */
  locationSource: string;
}

export interface RoadEstimate {
  miles: number;
  minutes: number;
  /** Restriction or routing notices from the provider, in its words (e.g. a weight limit on the route). */
  notices: string[];
  source: string;
}

export interface Leg {
  from: string;
  to: string;
  fromPoint: Point | null;
  toPoint: Point | null;
  /** Null when either end has no location. */
  straightMiles: number | null;
  road: RoadEstimate | null;
  /** Why there is no road estimate (no provider, missing location, provider error). */
  roadMissing: string | null;
}

export interface TruckRoute {
  truckId: string;
  unit: string;
  driver: string;
  trailer: string | null;
  stops: RouteStop[];
  legs: Leg[];
}

export interface RouteAssignment {
  truckId: string;
  unit: string;
  driver: string;
  trailer: string | null;
  stop: RouteStop;
}

const EARTH_MILES = 3958.8;

/** Great-circle distance in miles (the shortest possible; roads are always longer). */
export function straightLineMiles(a: Point, b: Point): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const YARD = "Yard";

/** One route per truck, stops in start-time order, with yard legs when the yard location is known. */
export function buildRoutes(assignments: RouteAssignment[], yard: Point | null): TruckRoute[] {
  const byTruck = new Map<string, RouteAssignment[]>();
  for (const a of assignments) byTruck.set(a.truckId, [...(byTruck.get(a.truckId) ?? []), a]);
  const routes: TruckRoute[] = [];
  for (const [truckId, list] of byTruck) {
    const stops = list.map((a) => a.stop).sort((x, y) => x.start.localeCompare(y.start) || x.loadNumber - y.loadNumber);
    const first = list[0];
    const ends: Array<{ label: string; point: Point | null }> = [
      ...(yard ? [{ label: YARD, point: yard }] : []),
      ...stops.map((s) => ({ label: `${s.orderNumber} · ${s.site}`, point: s.point })),
      ...(yard ? [{ label: YARD, point: yard }] : []),
    ];
    const legs: Leg[] = [];
    for (let i = 0; i + 1 < ends.length; i++) {
      const [a, b] = [ends[i], ends[i + 1]];
      // Two loads to the same site in a row are one stop: no leg between them.
      if (a.point && b.point && a.point.lat === b.point.lat && a.point.lng === b.point.lng && a.label !== YARD && b.label !== YARD) continue;
      legs.push({
        from: a.label,
        to: b.label,
        fromPoint: a.point,
        toPoint: b.point,
        straightMiles: a.point && b.point ? round1(straightLineMiles(a.point, b.point)) : null,
        road: null,
        roadMissing: a.point && b.point ? null : "A location is missing.",
      });
    }
    routes.push({ truckId, unit: first.unit, driver: first.driver, trailer: first.trailer, stops, legs });
  }
  return routes.sort((a, b) => a.unit.localeCompare(b.unit, undefined, { numeric: true }));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Totals over the legs; road totals only when every leg has a road estimate (never mixed with straight lines). */
export function routeTotals(route: TruckRoute): { straightMiles: number | null; roadMiles: number | null; roadMinutes: number | null; complete: boolean } {
  const complete = route.legs.length > 0 && route.legs.every((l) => l.straightMiles !== null);
  const straight = complete ? round1(route.legs.reduce((s, l) => s + (l.straightMiles ?? 0), 0)) : null;
  const allRoad = route.legs.length > 0 && route.legs.every((l) => l.road);
  return {
    straightMiles: straight,
    roadMiles: allRoad ? round1(route.legs.reduce((s, l) => s + l.road!.miles, 0)) : null,
    roadMinutes: allRoad ? Math.round(route.legs.reduce((s, l) => s + l.road!.minutes, 0)) : null,
    complete,
  };
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
}

/** Parses "lat, lng" typed by a person; null when it is not a valid pair. */
export function parsePoint(text: string): Point | null {
  const m = text.trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}
