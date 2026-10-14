import "server-only";
import { round1, type Point, type RoadEstimate } from "@/lib/routing/route";

// HERE adapter (owner 2026-10-14: HERE is the first truck-routing provider). Truck routing (transportMode=truck) and
// address geocoding. Server only. The key is never logged, returned or put in an error message; responses are not
// stored. Truck dimensions are not recorded in Taviron yet, so routes use HERE's default truck profile and the page
// says so.

export interface RoutingProvider {
  readonly name: string;
  route(from: Point, to: Point): Promise<RoadEstimate>;
  geocode(address: string): Promise<{ point: Point; score: number | null } | null>;
}

export class RoutingError extends Error {
  constructor(public readonly kind: "auth" | "rate_limit" | "timeout" | "provider" | "no_route", message: string) {
    super(message);
  }
}

const METERS_PER_MILE = 1609.344;

type Fetch = typeof fetch;

export class HereProvider implements RoutingProvider {
  readonly name = "HERE";
  constructor(private readonly key: string, private readonly timeoutMs = 8000, private readonly fetchImpl: Fetch = fetch) {}

  private async get(url: URL): Promise<unknown> {
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
    try {
      return await res.json();
    } catch {
      throw new RoutingError("provider", "The routing provider sent an unreadable answer.");
    }
  }

  async route(from: Point, to: Point): Promise<RoadEstimate> {
    const url = new URL("https://router.hereapi.com/v8/routes");
    url.searchParams.set("transportMode", "truck");
    url.searchParams.set("origin", `${from.lat},${from.lng}`);
    url.searchParams.set("destination", `${to.lat},${to.lng}`);
    url.searchParams.set("return", "summary");
    return parseHereRoute(await this.get(url));
  }

  async geocode(address: string): Promise<{ point: Point; score: number | null } | null> {
    const url = new URL("https://geocode.search.hereapi.com/v1/geocode");
    url.searchParams.set("q", address);
    url.searchParams.set("in", "countryCode:USA,CAN");
    url.searchParams.set("limit", "1");
    return parseHereGeocode(await this.get(url));
  }
}

/** Reads a HERE v8 routes answer: total length, duration and every notice (route-level and per section). */
export function parseHereRoute(body: unknown): RoadEstimate {
  const b = body as { routes?: Array<{ sections?: Array<{ summary?: { length?: number; duration?: number }; notices?: Array<{ title?: string; code?: string }> }> }>; notices?: Array<{ title?: string; code?: string }> };
  const route = b?.routes?.[0];
  if (!route?.sections?.length) {
    const why = (b?.notices ?? []).map((n) => n.title || n.code).filter(Boolean).join("; ");
    throw new RoutingError("no_route", why ? `No truck route found: ${why}.` : "No truck route found between these points.");
  }
  let meters = 0;
  let seconds = 0;
  const notices: string[] = [];
  for (const s of route.sections) {
    meters += Number(s.summary?.length ?? 0);
    seconds += Number(s.summary?.duration ?? 0);
    for (const n of s.notices ?? []) {
      const text = n.title || n.code;
      if (text && !notices.includes(text)) notices.push(text);
    }
  }
  return { miles: round1(meters / METERS_PER_MILE), minutes: Math.round(seconds / 60), notices, source: "HERE truck routing" };
}

export function parseHereGeocode(body: unknown): { point: Point; score: number | null } | null {
  const item = (body as { items?: Array<{ position?: { lat?: number; lng?: number }; scoring?: { queryScore?: number } }> })?.items?.[0];
  const lat = item?.position?.lat;
  const lng = item?.position?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { point: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 }, score: typeof item?.scoring?.queryScore === "number" ? item.scoring.queryScore : null };
}
