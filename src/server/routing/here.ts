import "server-only";
import { decodeFlexPolyline } from "@/lib/routing/flexpolyline";
import { round1, type GeocodeCandidate, type PlannedRoute, type Point, type RoadEstimate, type RouteNotice, type VehicleProfile } from "@/lib/routing/route";

// HERE adapter (owner 2026-10-14: HERE is the first truck-routing provider). Truck routing (transportMode=truck) with the
// truck's recorded dimensions, address geocoding with several candidates, and raster map tiles through the server.
// Server only. The key is never logged, returned or put in an error message; responses are not stored.

export interface RoutingProvider {
  readonly name: string;
  route(from: Point, to: Point, vehicle?: VehicleProfile | null): Promise<RoadEstimate>;
  /** Up to 5 matches for a person to choose from; empty when nothing matched. */
  geocodeCandidates(address: string): Promise<GeocodeCandidate[]>;
  /** A route through every point in order (first = origin, last = destination); alternatives only without via points. */
  plan(points: Point[], opts: { vehicle?: VehicleProfile | null; alternatives?: number }): Promise<PlannedRoute[]>;
  /** One 256 px raster map tile (PNG bytes). */
  tile(z: number, x: number, y: number): Promise<ArrayBuffer>;
}

export class RoutingError extends Error {
  constructor(public readonly kind: "auth" | "rate_limit" | "timeout" | "provider" | "no_route", message: string) {
    super(message);
  }
}

const METERS_PER_MILE = 1609.344;

type Fetch = typeof fetch;

function vehicleParams(url: URL, v: VehicleProfile | null | undefined) {
  if (!v) return;
  if (v.heightCm) url.searchParams.set("vehicle[height]", String(Math.round(v.heightCm)));
  if (v.widthCm) url.searchParams.set("vehicle[width]", String(Math.round(v.widthCm)));
  if (v.lengthCm) url.searchParams.set("vehicle[length]", String(Math.round(v.lengthCm)));
  if (v.grossWeightKg) url.searchParams.set("vehicle[grossWeight]", String(Math.round(v.grossWeightKg)));
  if (v.axleCount) url.searchParams.set("vehicle[axleCount]", String(Math.round(v.axleCount)));
}

export class HereProvider implements RoutingProvider {
  readonly name = "HERE";
  constructor(private readonly key: string, private readonly timeoutMs = 8000, private readonly fetchImpl: Fetch = fetch) {}

  private async request(url: URL): Promise<Response> {
    url.searchParams.set("apiKey", this.key);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs), cache: "no-store" });
    } catch (e) {
      throw new RoutingError(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "provider", "The routing provider did not answer.");
    }
    if (res.status === 401 || res.status === 403) throw new RoutingError("auth", "The routing provider refused the key.");
    if (res.status === 429) throw new RoutingError("rate_limit", "The routing provider's rate limit was reached.");
    if (!res.ok) throw new RoutingError("provider", `The routing provider failed (${res.status}).`);
    return res;
  }

  private async get(url: URL): Promise<unknown> {
    const res = await this.request(url);
    try {
      return await res.json();
    } catch {
      throw new RoutingError("provider", "The routing provider sent an unreadable answer.");
    }
  }

  async route(from: Point, to: Point, vehicle?: VehicleProfile | null): Promise<RoadEstimate> {
    const url = new URL("https://router.hereapi.com/v8/routes");
    url.searchParams.set("transportMode", "truck");
    url.searchParams.set("origin", `${from.lat},${from.lng}`);
    url.searchParams.set("destination", `${to.lat},${to.lng}`);
    url.searchParams.set("return", "summary");
    vehicleParams(url, vehicle);
    return parseHereRoute(await this.get(url));
  }

  async geocodeCandidates(address: string): Promise<GeocodeCandidate[]> {
    const url = new URL("https://geocode.search.hereapi.com/v1/geocode");
    url.searchParams.set("q", address);
    url.searchParams.set("in", "countryCode:USA,CAN");
    url.searchParams.set("limit", "5");
    return parseHereCandidates(await this.get(url));
  }

  async plan(points: Point[], opts: { vehicle?: VehicleProfile | null; alternatives?: number }): Promise<PlannedRoute[]> {
    if (points.length < 2) throw new RoutingError("no_route", "A route needs at least two places.");
    const url = new URL("https://router.hereapi.com/v8/routes");
    url.searchParams.set("transportMode", "truck");
    url.searchParams.set("origin", `${points[0].lat},${points[0].lng}`);
    url.searchParams.set("destination", `${points[points.length - 1].lat},${points[points.length - 1].lng}`);
    for (const p of points.slice(1, -1)) url.searchParams.append("via", `${p.lat},${p.lng}!passThrough=false`);
    url.searchParams.set("return", "summary,polyline");
    if (points.length === 2 && opts.alternatives) url.searchParams.set("alternatives", String(Math.min(3, opts.alternatives)));
    vehicleParams(url, opts.vehicle);
    return parseHerePlan(await this.get(url));
  }

  async tile(z: number, x: number, y: number): Promise<ArrayBuffer> {
    const url = new URL(`https://maps.hereapi.com/v3/base/mc/${z}/${x}/${y}/png8`);
    url.searchParams.set("style", "explore.day");
    url.searchParams.set("size", "256");
    return (await this.request(url)).arrayBuffer();
  }
}

type HereNotice = { title?: string; code?: string; severity?: string };

/** HERE marks restrictions its route could not avoid as critical notices; everything else is informational. */
export function noticeOf(n: HereNotice): RouteNotice | null {
  const text = n.title || n.code;
  if (!text) return null;
  return { text, code: n.code ?? "", severity: n.severity === "critical" || /violated/i.test(n.code ?? "") ? "critical" : "info" };
}

function addNotices(into: RouteNotice[], list: HereNotice[] | undefined) {
  for (const raw of list ?? []) {
    const n = noticeOf(raw);
    if (n && !into.some((x) => x.text === n.text)) into.push(n);
  }
}

type HereSection = { summary?: { length?: number; duration?: number }; notices?: HereNotice[]; polyline?: string };
type HereRoutes = { routes?: Array<{ sections?: HereSection[] }>; notices?: HereNotice[] };

function noRoute(b: HereRoutes): RoutingError {
  const why = (b?.notices ?? []).map((n) => n.title || n.code).filter(Boolean).join("; ");
  return new RoutingError("no_route", why ? `No truck route found: ${why}.` : "No truck route found between these points.");
}

/** Reads a HERE v8 routes answer: total length, duration and every notice (route-level and per section). */
export function parseHereRoute(body: unknown): RoadEstimate {
  const b = body as HereRoutes;
  const route = b?.routes?.[0];
  if (!route?.sections?.length) throw noRoute(b);
  let meters = 0;
  let seconds = 0;
  const notices: RouteNotice[] = [];
  for (const s of route.sections) {
    meters += Number(s.summary?.length ?? 0);
    seconds += Number(s.summary?.duration ?? 0);
    addNotices(notices, s.notices);
  }
  return { miles: round1(meters / METERS_PER_MILE), minutes: Math.round(seconds / 60), notices: notices.map((n) => n.text), source: "HERE truck routing" };
}

/** Every route in the answer (the first is HERE's choice; others are alternatives), one leg per section. */
export function parseHerePlan(body: unknown): PlannedRoute[] {
  const b = body as HereRoutes;
  const routes = (b?.routes ?? []).filter((r) => r.sections?.length);
  if (!routes.length) throw noRoute(b);
  return routes.map((r) => {
    const notices: RouteNotice[] = [];
    const line: Point[] = [];
    const legs = r.sections!.map((s) => {
      const legNotices: RouteNotice[] = [];
      addNotices(legNotices, s.notices);
      addNotices(notices, s.notices);
      if (s.polyline) {
        try {
          line.push(...decodeFlexPolyline(s.polyline));
        } catch {
          /* a line we cannot read only removes the drawing, never the numbers */
        }
      }
      return { miles: round1(Number(s.summary?.length ?? 0) / METERS_PER_MILE), minutes: Math.round(Number(s.summary?.duration ?? 0) / 60), notices: legNotices };
    });
    return {
      miles: round1(legs.reduce((a, l) => a + l.miles, 0)),
      minutes: legs.reduce((a, l) => a + l.minutes, 0),
      legs,
      line,
      notices,
      source: "HERE truck routing",
    };
  });
}

export function parseHereCandidates(body: unknown): GeocodeCandidate[] {
  const items = (body as { items?: Array<{ title?: string; address?: { label?: string }; resultType?: string; houseNumberType?: string; position?: { lat?: number; lng?: number }; scoring?: { queryScore?: number } }> })?.items ?? [];
  const out: GeocodeCandidate[] = [];
  for (const item of items.slice(0, 5)) {
    const lat = item.position?.lat;
    const lng = item.position?.lng;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    out.push({
      point: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 },
      label: item.address?.label || item.title || `${lat}, ${lng}`,
      score: typeof item.scoring?.queryScore === "number" ? item.scoring.queryScore : null,
      precision: item.resultType ?? "",
    });
  }
  return out;
}

/** The first match only (kept for callers that still look one address up; prefer geocodeCandidates). */
export function parseHereGeocode(body: unknown): { point: Point; score: number | null } | null {
  const first = parseHereCandidates(body)[0];
  return first ? { point: first.point, score: first.score } : null;
}
