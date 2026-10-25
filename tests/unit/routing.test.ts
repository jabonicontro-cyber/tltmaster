import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRoutes, formatMinutes, parsePoint, routeTotals, straightLineMiles, YARD, type RouteAssignment } from "@/lib/routing/route";
import { HereProvider, parseHereCandidates, parseHereGeocode, parseHerePlan, parseHereRoute, RoutingError, type RoutingProvider } from "@/server/routing/here";
import { decodeFlexPolyline } from "@/lib/routing/flexpolyline";
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
    // Several matches are all returned for a person to choose from, with the provider's own label and precision.
    const many = parseHereCandidates({ items: [
      { title: "100 Main St, Rensselaer, IN", address: { label: "100 Main St, Rensselaer, IN 47978" }, resultType: "houseNumber", position: { lat: 40.93, lng: -87.15 }, scoring: { queryScore: 0.95 } },
      { title: "Main St, Remington, IN", resultType: "street", position: { lat: 40.76, lng: -87.15 } },
      { title: "no position" },
    ] });
    expect(many).toEqual([
      { point: { lat: 40.93, lng: -87.15 }, label: "100 Main St, Rensselaer, IN 47978", score: 0.95, precision: "houseNumber" },
      { point: { lat: 40.76, lng: -87.15 }, label: "Main St, Remington, IN", score: null, precision: "street" },
    ]);
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
      geocodeCandidates: async () => [],
      plan: async () => [],
      tile: async () => new ArrayBuffer(0),
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

describe("route builder: multi-stop truck routes", () => {
  it("decodes HERE's flexible polyline (reference example)", () => {
    expect(decodeFlexPolyline("BFoz5xJ67i1B1B7PzIhaxL7Y")).toEqual([
      { lat: 50.10228, lng: 8.69821 }, { lat: 50.10201, lng: 8.69567 }, { lat: 50.10063, lng: 8.6915 }, { lat: 50.09878, lng: 8.68752 },
    ]);
    expect(() => decodeFlexPolyline("B!!")).toThrow();
  });

  it("reads every route and leg with critical restriction notices kept apart from information", () => {
    const routes = parseHerePlan({ routes: [
      { sections: [
        { summary: { length: 16093.44, duration: 1200 }, polyline: "BFoz5xJ67i1B1B7PzIhaxL7Y", notices: [{ title: "Violated vehicle restriction: height", code: "violatedVehicleRestriction", severity: "critical" }] },
        { summary: { length: 8046.72, duration: 600 }, notices: [{ title: "Toll road", code: "tollRoad" }] },
      ] },
      { sections: [{ summary: { length: 32186.88, duration: 2100 } }] },
    ] });
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ miles: 15, minutes: 30, legs: [{ miles: 10, minutes: 20 }, { miles: 5, minutes: 10 }] });
    expect(routes[0].notices).toEqual([
      { text: "Violated vehicle restriction: height", code: "violatedVehicleRestriction", severity: "critical" },
      { text: "Toll road", code: "tollRoad", severity: "info" },
    ]);
    expect(routes[0].line).toHaveLength(4);
    expect(() => parseHerePlan({ routes: [], notices: [{ title: "No route" }] })).toThrow(/No truck route found/);
  });

  it("sends the truck's recorded dimensions, via points and alternatives; the key never appears in errors", async () => {
    const seen: URL[] = [];
    const fetchImpl = async (u: URL) => {
      seen.push(new URL(u));
      return new Response(JSON.stringify({ routes: [{ sections: [{ summary: { length: 1609.344, duration: 60 } }] }] }), { status: 200 });
    };
    const key = "k".repeat(30);
    const p = new HereProvider(key, 1000, fetchImpl as unknown as typeof fetch);
    await p.plan([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }, { lat: 5, lng: 6 }], { vehicle: { heightCm: 411, grossWeightKg: 36287, axleCount: 5 } });
    const q = seen[0].searchParams;
    expect(q.get("transportMode")).toBe("truck");
    expect(q.getAll("via")).toEqual(["3,4!passThrough=false"]);
    expect(q.get("vehicle[height]")).toBe("411");
    expect(q.get("vehicle[grossWeight]")).toBe("36287");
    expect(q.get("vehicle[axleCount]")).toBe("5");
    expect(q.get("alternatives")).toBeNull(); // not with via points
    await p.plan([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], { alternatives: 2 });
    expect(seen[1].searchParams.get("alternatives")).toBe("2");
    const denied = new HereProvider(key, 1000, (async () => new Response("", { status: 401 })) as unknown as typeof fetch);
    const err = await denied.plan([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], {}).catch((e) => e);
    expect(err).toBeInstanceOf(RoutingError);
    expect(String(err.message)).not.toContain(key);
  });
});

describe("route builder: suggested stop order", () => {
  it("keeps the start (and a fixed end), visits every stop once and never makes the path longer", async () => {
    const { suggestOrder, straightLineMatrix, pathLength } = await import("@/lib/routing/optimize");
    // A yard and five stops out of order along a line east of it.
    const pts = [{ lat: 40, lng: -87 }, { lat: 40, lng: -86.6 }, { lat: 40, lng: -86.9 }, { lat: 40, lng: -86.5 }, { lat: 40, lng: -86.8 }, { lat: 40, lng: -86.7 }];
    const d = straightLineMatrix(pts);
    const open = suggestOrder(pts.length, d, false);
    expect(open[0]).toBe(0);
    expect([...open].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(open).toEqual([0, 2, 4, 5, 1, 3]);
    expect(pathLength(open, d)).toBeLessThan(pathLength([0, 1, 2, 3, 4, 5], d));
    const back = [...pts, pts[0]];
    const closed = suggestOrder(back.length, straightLineMatrix(back), true);
    expect(closed[0]).toBe(0);
    expect(closed[closed.length - 1]).toBe(back.length - 1);
    expect(new Set(closed).size).toBe(back.length);
    expect(suggestOrder(3, d, true)).toEqual([0, 1, 2]);
  });
});

describe("truck routing dimensions (feet and pounds in, cm and kg stored)", async () => {
  const { truckDimensionsSchema, cmToFeet, kgToPounds } = await import("@/lib/routing/dimensions");
  it("converts and round-trips", () => {
    const r = truckDimensionsSchema.parse({ height_cm: "13.5", width_cm: "8.5", length_cm: "34", gross_weight_kg: "73,000", axle_count: "4" });
    expect(r).toEqual({ height_cm: 411, width_cm: 259, length_cm: 1036, gross_weight_kg: 33112, axle_count: 4 });
    expect([cmToFeet(r.height_cm), cmToFeet(r.width_cm), kgToPounds(r.gross_weight_kg)]).toEqual(["13.5", "8.5", "73000"]);
  });
  it("blank is unknown; out-of-range values are refused before the database", () => {
    expect(truckDimensionsSchema.parse({})).toEqual({ height_cm: null, width_cm: null, length_cm: null, gross_weight_kg: null, axle_count: null });
    const bad = truckDimensionsSchema.safeParse({ height_cm: "40", axle_count: "1", gross_weight_kg: "-5" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path[0]).sort()).toEqual(["axle_count", "gross_weight_kg", "height_cm"]);
  });
});
