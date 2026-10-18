import { describe, expect, it } from "vitest";
import { buildOutlook, nextSteps, outlookTotals, truckDownReason, type OutlookInput } from "@/lib/live/outlook";
import { estimateLoadRevenueCents } from "@/lib/orders/load-revenue";

const days = ["2026-10-18", "2026-10-19", "2026-10-20"];
const base = (over: Partial<OutlookInput> = {}): OutlookInput => ({
  days,
  loads: [],
  trucks: [
    { id: "t1", service_status: "in_service", expected_return_date: null },
    { id: "t2", service_status: "in_service", expected_return_date: null },
    { id: "t3", service_status: "out_of_service", expected_return_date: "2026-10-20" },
  ],
  shop: [],
  drivers: 4,
  timeOff: [],
  ...over,
});

describe("Taviron Live outlook", () => {
  it("counts loads, coverage and trucks that can run per day", () => {
    const o = buildOutlook(base({
      loads: [
        { id: "a", load_date: "2026-10-18", truck_id: "t1", revenue_cents: null },
        { id: "b", load_date: "2026-10-18", truck_id: null, revenue_cents: 50_000 },
        { id: "c", load_date: "2026-10-19", truck_id: null, revenue_cents: null },
      ],
    }));
    expect(o.map((d) => [d.loads, d.assigned, d.unassigned])).toEqual([[2, 1, 1], [1, 0, 1], [0, 0, 0]]);
    // t3 is out of service until its expected return date (back on 2026-10-20).
    expect(o.map((d) => d.trucksReady)).toEqual([2, 2, 3]);
    expect(o[0].uncoveredValueCents).toBe(50_000);
    expect(o[1].uncoveredWithoutRate).toBe(1); // counted, never guessed
  });

  it("applies the dispatch rules for equipment: safety-critical work blocks every day, a shop visit only its day", () => {
    const shop = new Map([["t1", [{ truck_id: "t1", status: "scheduled", scheduled_for: "2026-10-19", safety_critical: false }]], ["t2", [{ truck_id: "t2", status: "reported", scheduled_for: null, safety_critical: true }]]]);
    const t1 = { id: "t1", service_status: "in_service", expected_return_date: null };
    const t2 = { id: "t2", service_status: "in_service", expected_return_date: null };
    expect([truckDownReason(t1, "2026-10-18", shop), truckDownReason(t1, "2026-10-19", shop)]).toEqual([null, "shop"]);
    expect(truckDownReason(t2, "2026-10-18", shop)).toBe("safety_restricted");
    expect(truckDownReason({ id: "x", service_status: "out_of_service", expected_return_date: null }, "2030-01-01", shop)).toBe("out_of_service");
  });

  it("flags booked loads on equipment that cannot run that day, and puts them first in the next steps", () => {
    const o = buildOutlook(base({
      shop: [{ truck_id: "t1", status: "scheduled", scheduled_for: "2026-10-19", safety_critical: false }],
      loads: [
        { id: "a", load_date: "2026-10-19", truck_id: "t1", revenue_cents: null },
        { id: "b", load_date: "2026-10-18", truck_id: null, revenue_cents: null },
      ],
    }));
    expect(o.map((d) => d.conflicts)).toEqual([0, 1, 0]);
    const steps = nextSteps(o, "2026-10-18");
    expect(steps[0]).toMatchObject({ key: "conflict:2026-10-19", urgent: true, href: "/dispatch?date=2026-10-19" });
    expect(steps[1]).toMatchObject({ key: "gap:2026-10-18", urgent: true });
    expect(steps[1].text).toContain("today");
  });

  it("counts drivers off only for approved full days; partial days and pending requests are shown apart", () => {
    const o = buildOutlook(base({
      timeOff: [
        { driver_id: "d1", status: "approved", first_day: "2026-10-18", last_day: "2026-10-19", full_day: true },
        { driver_id: "d2", status: "approved", first_day: "2026-10-18", last_day: "2026-10-18", full_day: false },
        { driver_id: "d3", status: "pending", first_day: "2026-10-20", last_day: "2026-10-20", full_day: true },
      ],
    }));
    expect(o.map((d) => [d.driversAvailable, d.driversOff, d.driversPartial, d.driversPending])).toEqual([[3, 1, 1, 0], [3, 1, 0, 0], [4, 0, 0, 1]]);
  });

  it("totals the window and names the first day with a gap; nothing to do when everything is covered", () => {
    const o = buildOutlook(base({ loads: [{ id: "a", load_date: "2026-10-20", truck_id: null, revenue_cents: 1_000 }] }));
    expect(outlookTotals(o)).toEqual({ loads: 1, unassigned: 1, conflicts: 0, uncoveredValueCents: 1_000, uncoveredWithoutRate: 0, firstGap: "2026-10-20" });
    expect(nextSteps(buildOutlook(base()), "2026-10-18")).toEqual([]);
  });
});

describe("load revenue estimate", () => {
  const lines = [
    { order_id: "o", kind: "material", calc_method: "per_unit", unit_code: "ton", unit_rate_cents: 1000 },
    { order_id: "o", kind: "hauling", calc_method: "per_unit", unit_code: "ton", unit_rate_cents: "500" },
    { order_id: "o", kind: "surcharge", calc_method: "per_unit", unit_code: "ton", unit_rate_cents: 99 },
    { order_id: "o", kind: "hauling", calc_method: "per_unit", unit_code: "hour", unit_rate_cents: 9000 },
  ];
  it("adds material and hauling rates in the load's unit × planned quantity; no rate or quantity → null", () => {
    expect(estimateLoadRevenueCents(lines, { order_id: "o", unit_code: "ton", planned_quantity: 22.5 })).toBe(33_750);
    expect(estimateLoadRevenueCents(lines, { order_id: "o", unit_code: "load", planned_quantity: 1 })).toBeNull();
    expect(estimateLoadRevenueCents(lines, { order_id: "o", unit_code: "ton", planned_quantity: null })).toBeNull();
  });
});
