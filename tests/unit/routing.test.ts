import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRoutes, formatMinutes, parsePoint, routeTotals, straightLineMiles, YARD, type RouteAssignment } from "@/lib/routing/route";
import { HereProvider, parseHereGeocode, parseHereRoute, RoutingError, type RoutingProvider } from "@/server/routing/here";
import { addRoadEstimates, clearRoutingCacheForTests, MAX_CALLS, parseRoutingConfig, routingStatus, setRoutingProviderForTests } from "@/server/routing/service";

vi.mock("server-only", () => ({}));

// Route planner (docs/ROUTING.md): pure route building, the HERE adapter's parsing (no live calls: fetch is mocked),
// configuration, the demo switch and the per-page call cap.

const RENSSELAER = { lat: 40.9367, lng: -87.1509 };
const LAFAYETTE = { lat: 40.4167, lng: -86.8753 };
const stop = (n: number, start: string, point = LAFAYETTE, site = "Plant 2") => ({
  loadId: `l${n}`, orderId: `o${n}`, orderNumber: `ORD-${n}`, loadNumber: n, customer: "Ridgeline", site, address: "880 Example Pkwy, Lafayette",
  siteId: `s${n}`, start, end: start, point, locationSource: "manual",
});
const asg = (truck: string, s: ReturnType<typeof stop>): RouteAssignment => ({ truckId: truck, unit: truck, driver: "Driver", trailer: null, stop: s });

afterEach(() => {
  clearRoutingCacheForTests();
  setRoutingProviderForTests(null);
});

describe("route building", () => {
  it("straight-line miles between two real towns are plausible (Rensselaer → Lafayette ≈ 38 mi)", () => {
    const d = straightLineMiles(RENSSELAER, LAFAYETTE);
    expect(d).toBeGreaterThan(35);
    expect(d).toBeLessThan(40);
  });

  it("one route per truck: yard → stops by start time → yard; consecutive loads at one site are one stop", () => {
    const routes = buildRoutes([asg("201", stop(2, "10:00")), asg("201", stop(1, "07:00")), asg("201", stop(3, "12:00", RENSSELAER, "Elevator")), asg("202", stop(4, "08:00"))], RENSSELAER);
    expect(routes.map((r) => r.unit)).toEqual(["201", "202"]);
    const r = routes[0];
    expect(r.stops.map((s) => s.loadNumber)).toEqual([1, 2, 3]);
    // yard→1, (1→2 skipped: same site), 2→3, 3→yard
    expect(r.legs.map((l) => [l.from === YARD ? "Y" : l.from.slice(4, 5), l.to === YARD ? "Y" : l.to.slice(4, 5)])).toEqual([["Y", "1"], ["2", "3"], ["3", "Y"]]);
    expect(routeTotals(r).straightMiles).toBeGreaterThan(70);
    expect(routeTotals(r).roadMiles).toBeNull(); // never mixed with straight lines
  });

  it("a missing location means no distance for its legs and no total", () => {
    const [r] = buildRoutes([asg("201", { ...stop(1, "07:00"), point: null as never })], RENSSELAER);
    expect(r.legs.every((l) => l.straightMiles === null && l.roadMissing)).toBe(true);
    expect(routeTotals(r)).toMatchObject({ straightMiles: null, complete: false });
  });

  it("without a yard the route starts at the first delivery", () => {
    const [r] = buildRoutes([asg("201", stop(1, "07:00")), asg("201", stop(2, "09:00", RENSSELAER, "Elevator"))], null);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0].from).toContain("ORD-1");
  });

  it("parses typed coordinates and rejects anything else", () => {
    expect(parsePoint("40.9367, -87.1509")).toEqual(RENSSELAER);
    expect(parsePoint("40.9367 -87.1509")).toEqual(RENSSELAER);
    for (const bad of ["", "abc", "91, 10", "10, 181", "40.9;-87.1"]) expect(parsePoint(bad), bad).toBeNull();
    expect(formatMinutes(125)).toBe("2 h 05 min");
    expect(formatMinutes(40)).toBe("40 min");
  });
});

describe("HERE adapter", () => {
  it("reads length, duration and notices across sections", () => {
    const est = parseHereRoute({ routes: [{ sections: [
      { summary: { length: 16093, duration: 900 }, notices: [{ title: "Truck weight restriction ahead", code: "violatedVehicleRestriction" }] },
      { summary: { length: 16093, duration: 900 } },
    ] }] });
    expect(est).toEqual({ miles: 20, minutes: 30, notices: ["Truck weight restriction ahead"], source: "HERE truck routing" });
  });

  it("no route is an error with HERE's reason; a geocode without items is null", () => {
    expect(() => parseHereRoute({ routes: [], notices: [{ title: "Couldn't find a route" }] })).toThrow(/No truck route found: Couldn't find a route/);
    expect(parseHereGeocode({ items: [] })).toBeNull();
    expect(parseHereGeocode({ items: [{ position: { lat: 40.93671234, lng: -87.15091234 }, scoring: { queryScore: 0.97 } }] })).toEqual({ point: { lat: 40.936712, lng: -87.150912 }, score: 0.97 });
  });

  it("sends truck mode and the key only as a query parameter; errors never contain the key", async () => {
    const key = "test-key-0123456789abcdefghij";
    const fetchImpl = vi.fn(async (url: URL) => {
      expect(url.searchParams.get("transportMode")).toBe("truck");
      expect(url.searchParams.get("apiKey")).toBe(key);
      return new Response("{}", { status: 401 });
    });
    const p = new HereProvider(key, 1000, fetchImpl as unknown as typeof fetch);
    const err = await p.route(RENSSELAER, LAFAYETTE).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingError);
    expect(err.kind).toBe("auth");
    expect(String(err.message)).not.toContain(key);
  });
});

describe("configuration and limits", () => {
  it("a key alone is not enough; malformed values are named, never echoed", () => {
    expect(parseRoutingConfig({ HERE_API_KEY: "a".repeat(30) }).provider).toBeNull();
    const c = parseRoutingConfig({ ROUTING_PROVIDER: "here", HERE_API_KEY: "bad key with spaces" });
    expect(c.key).toBeNull();
    expect(c.invalid).toEqual(["HERE_API_KEY"]);
    expect(routingStatus({ isDemo: false }, c).state).toBe("not_configured");
  });

  it("demo companies stay on straight lines unless ROUTING_IN_DEMOS=on", () => {
    const env = { ROUTING_PROVIDER: "here", HERE_API_KEY: "k".repeat(30) };
    expect(routingStatus({ isDemo: true }, parseRoutingConfig(env)).state).toBe("demo_off");
    expect(routingStatus({ isDemo: true }, parseRoutingConfig({ ...env, ROUTING_IN_DEMOS: "on" })).state).toBe("ready");
    expect(routingStatus({ isDemo: false }, parseRoutingConfig(env)).state).toBe("ready");
  });

  it("road estimates are cached and capped per page; failures are shown, not hidden", async () => {
    let calls = 0;
    const provider: RoutingProvider = {
      name: "fake",
      route: async (a) => {
        calls++;
        if (a.lat === 1) throw new RoutingError("timeout", "The routing provider did not answer.");
        return { miles: 10, minutes: 15, notices: [], source: "fake" };
      },
      geocode: async () => null,
    };
    const many = Array.from({ length: MAX_CALLS + 5 }, (_, i) => asg(`T${i}`, stop(i, "07:00", { lat: 40 + i / 100, lng: -87 })));
    const routes = buildRoutes(many, RENSSELAER);
    const first = await addRoadEstimates(routes, provider);
    expect(first.calls).toBe(MAX_CALLS);
    expect(first.capped).toBe(true);
    expect(routes.flatMap((r) => r.legs).some((l) => l.roadMissing?.startsWith("Not routed"))).toBe(true);
    const again = buildRoutes(many.slice(0, 3), RENSSELAER);
    const before = calls;
    await addRoadEstimates(again, provider);
    expect(calls).toBe(before); // all cached
    const failing = buildRoutes([asg("X", stop(99, "07:00", { lat: 1, lng: 1 }))], { lat: 1, lng: 1 });
    await addRoadEstimates(failing, provider);
    expect(failing[0].legs.every((l) => l.road === null && l.roadMissing === "The routing provider did not answer.")).toBe(true);
  });
});
