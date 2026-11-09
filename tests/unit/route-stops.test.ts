import { describe, expect, it } from "vitest";
import { legArrivals, stopTimes } from "@/components/routing/route-stops";
import { buildRoutes, type RouteAssignment, type RouteStop } from "@/lib/routing/route";

// B3: a second delivery to the same site showed the first one's times (stops were found by their label), and times
// were 24-hour while the app is 12-hour.

const site = { lat: 41.6, lng: -88.1 };
const other = { lat: 41.7, lng: -88.3 };
const yard = { lat: 41.5, lng: -88.0 };
const stop = (n: number, start: string, end: string, extra: Partial<RouteStop> = {}): RouteStop => ({
  loadId: `L${n}`, orderId: "O1", orderNumber: "ORD-1010", loadNumber: n, customer: "Harlow Homes", site: "Harlow Meadows", address: "", siteId: "S1",
  start, end, point: site, locationSource: "manual", ...extra,
});
const on = (stops: RouteStop[]): RouteAssignment[] => stops.map((s) => ({ truckId: "T1", unit: "101", driver: "Avery", trailer: null, stop: s }));

describe("route stops (B3)", () => {
  it("gives each delivery to the same site its own times, with a pickup between them", () => {
    const pickup = { name: "North Quarry", point: other };
    const [r] = buildRoutes(on([stop(1, "07:00", "08:00", { pickup }), stop(2, "13:00", "14:30", { pickup })]), yard);
    const a = legArrivals(r, true);
    const sites = r.legs.map((l, i) => ({ to: l.to, times: stopTimes(a.to[i]) })).filter((x) => x.times);
    expect(sites).toEqual([
      { to: "ORD-1010 · Harlow Meadows", times: "Harlow Homes · 7:00 AM–8:00 AM" },
      { to: "ORD-1010 · Harlow Meadows", times: "Harlow Homes · 1:00 PM–2:30 PM" },
    ]);
  });

  it("lists every load when consecutive loads at the same point are one stop", () => {
    const [r] = buildRoutes(on([stop(1, "07:00", "08:00"), stop(2, "13:00", "14:30")]), yard);
    expect(r.legs.map((l) => l.to)).toEqual(["ORD-1010 · Harlow Meadows", "Yard"]);
    const a = legArrivals(r, true);
    expect(a.to[0].map((s) => s.loadId)).toEqual(["L1", "L2"]);
    expect(stopTimes(a.to[0])).toBe("Harlow Homes · load 1 7:00 AM–8:00 AM, load 2 1:00 PM–2:30 PM");
    expect(a.to[1]).toEqual([]);
  });

  it("starts at the first delivery without a yard, and keeps unlocated stops apart", () => {
    const [r] = buildRoutes(on([stop(1, "07:00", "08:00", { point: null }), stop(2, "09:00", "10:00", { point: null }), stop(3, "11:00", "12:00", { point: other, site: "Elm St", orderNumber: "ORD-2" })]), null);
    const a = legArrivals(r, false);
    expect(a.from.map((s) => s.loadId)).toEqual(["L1"]);
    expect(a.to.map((g) => g.map((s) => s.loadId))).toEqual([["L2"], ["L3"]]);
    expect(stopTimes(a.to[1])).toBe("Harlow Homes · 11:00 AM–12:00 PM");
  });
});
