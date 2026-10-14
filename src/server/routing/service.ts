import "server-only";
import type { Leg, Point, TruckRoute } from "@/lib/routing/route";
import { HereProvider, RoutingError, type RoutingProvider } from "./here";

// Routing configuration and the road estimates for a day's routes (docs/ROUTING.md). Read on the server only.
//
// - ROUTING_PROVIDER=here and HERE_API_KEY turn on truck routing. Without them the route planner works with
//   straight-line distances, labelled as such, and says road routing is not set up.
// - ROUTING_IN_DEMOS=on lets demo companies call the provider too (default off: each call counts against the owner's
//   HERE account; DEMO_TENANTS §2).
// - Answers are cached in memory for a few hours (by rounded coordinates) and a page asks for at most MAX_CALLS legs,
//   so one busy page cannot spend the free tier. Nothing is stored in the database.

export interface RoutingConfig {
  provider: "here" | null;
  /** Present only when set and well-formed. Never logged or sent to the browser. */
  key: string | null;
  inDemos: boolean;
  timeoutMs: number;
  /** Names (never values) of settings that were set but malformed. */
  invalid: string[];
}

export function parseRoutingConfig(env: Record<string, string | undefined>): RoutingConfig {
  const invalid: string[] = [];
  const v = (k: string) => env[k]?.trim() || undefined;
  const provider = v("ROUTING_PROVIDER");
  if (provider && provider !== "here") invalid.push("ROUTING_PROVIDER");
  const key = v("HERE_API_KEY");
  if (key && !/^[A-Za-z0-9_-]{20,128}$/.test(key)) invalid.push("HERE_API_KEY");
  const timeout = Number(v("ROUTING_TIMEOUT_MS") ?? 8000);
  return {
    provider: provider === "here" ? "here" : null,
    key: key && !invalid.includes("HERE_API_KEY") ? key : null,
    inDemos: v("ROUTING_IN_DEMOS") === "on",
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 30000 ? timeout : 8000,
    invalid,
  };
}

export type RoutingStatus =
  | { state: "ready"; provider: RoutingProvider }
  | { state: "not_configured" | "demo_off"; reason: string };

let providerFactory: (c: RoutingConfig) => RoutingProvider = (c) => new HereProvider(c.key!, c.timeoutMs);
/** Tests only: replace the provider (never a live call in the test suites). */
export function setRoutingProviderForTests(f: ((c: RoutingConfig) => RoutingProvider) | null) {
  providerFactory = f ?? ((c) => new HereProvider(c.key!, c.timeoutMs));
}

/** The one place routing branches on demo companies (DEMO_TENANTS §2): pass the caller's access. */
export function routingStatus(access: { isDemo?: boolean }, config = parseRoutingConfig(process.env)): RoutingStatus {
  const isDemo = Boolean(access.isDemo);
  if (config.provider !== "here" || !config.key) {
    return { state: "not_configured", reason: "Truck routing is not set up yet (the owner adds a HERE key). Distances below are straight lines." };
  }
  if (isDemo && !config.inDemos) {
    return { state: "demo_off", reason: "Truck routing is off in demo companies. Distances below are straight lines." };
  }
  return { state: "ready", provider: providerFactory(config) };
}

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
export const MAX_CALLS = 40;
const cache = new Map<string, { at: number; value: Leg["road"] | RoutingError }>();
const keyOf = (a: Point, b: Point) => [a.lat, a.lng, b.lat, b.lng].map((n) => n.toFixed(4)).join(",");

/** Fills each leg's road estimate from the provider (cached), up to MAX_CALLS new calls per request. */
export async function addRoadEstimates(routes: TruckRoute[], provider: RoutingProvider): Promise<{ calls: number; capped: boolean }> {
  let calls = 0;
  let capped = false;
  for (const route of routes) {
    for (const leg of route.legs) {
      const [a, b] = [leg.fromPoint, leg.toPoint];
      if (!a || !b) continue;
      const k = keyOf(a, b);
      const hit = cache.get(k);
      if (hit && Date.now() - hit.at < TTL_MS) {
        applyResult(leg, hit.value);
        continue;
      }
      if (calls >= MAX_CALLS) {
        capped = true;
        leg.roadMissing = "Not routed: too many legs on this page at once. Filter by truck to route the rest.";
        continue;
      }
      calls++;
      let value: Leg["road"] | RoutingError;
      try {
        value = await provider.route(a, b);
      } catch (e) {
        value = e instanceof RoutingError ? e : new RoutingError("provider", "The routing provider failed.");
      }
      // Failures that may pass (timeouts, rate limits) are not cached.
      if (!(value instanceof RoutingError) || value.kind === "no_route") {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
        cache.set(k, { at: Date.now(), value });
      }
      applyResult(leg, value);
    }
  }
  return { calls, capped };
}

function applyResult(leg: Leg, value: Leg["road"] | RoutingError) {
  if (value instanceof RoutingError) {
    leg.road = null;
    leg.roadMissing = value.message;
  } else {
    leg.road = value;
    leg.roadMissing = null;
  }
}

export function clearRoutingCacheForTests() {
  cache.clear();
}
