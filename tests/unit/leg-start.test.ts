import { describe, expect, it } from "vitest";
import { legStart, YARD, type RouteAssignment } from "@/lib/routing/route";

// Where a truck sets off for a load (owner 2026-10-26): the yard for its first load of the day, otherwise the site of
// its previous delivery that day.
const yard = { lat: 40, lng: -87 };
const stop = (loadId: string, start: string, site: string, point: { lat: number; lng: number } | null, loadNumber = 1): RouteAssignment => ({
  truckId: "t1", unit: "101", driver: "Avery", trailer: null,
  stop: { loadId, orderId: `o-${site}`, orderNumber: `ORD-${site}`, loadNumber, customer: "C", site, address: "", siteId: null, start, end: start, point, locationSource: "manual" },
});

describe("legStart", () => {
  const day = [stop("a", "07:00", "North", { lat: 41, lng: -87 }), stop("b", "10:00", "South", { lat: 39, lng: -87 }), { ...stop("c", "08:00", "Other", { lat: 0, lng: 0 }), truckId: "t2" }];

  it("starts the truck's first load of the day at the yard", () => {
    expect(legStart(day, "t1", { loadId: "a", start: "07:00", loadNumber: 1 }, yard)).toEqual({ kind: "base", label: YARD, point: yard });
  });

  it("starts later loads where the truck's previous delivery left it, ignoring other trucks", () => {
    expect(legStart(day, "t1", { loadId: "b", start: "10:00", loadNumber: 1 }, yard)).toEqual({ kind: "previous", label: "ORD-North · North", point: { lat: 41, lng: -87 } });
    expect(legStart(day, "t1", { loadId: "x", start: "12:00", loadNumber: 1 }, yard).label).toBe("ORD-South · South");
  });

  it("orders loads at the same time by load number, and keeps a missing location missing", () => {
    const same = [stop("p", "09:00", "Pit", null, 1), stop("q", "09:00", "Pit", null, 2)];
    expect(legStart(same, "t1", { loadId: "q", start: "09:00", loadNumber: 2 }, yard)).toEqual({ kind: "previous", label: "ORD-Pit · Pit", point: null });
    expect(legStart(same, "t1", { loadId: "p", start: "09:00", loadNumber: 1 }, null)).toEqual({ kind: "base", label: YARD, point: null });
  });
});
