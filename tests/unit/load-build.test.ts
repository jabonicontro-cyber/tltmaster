import { describe, expect, it } from "vitest";
import { buildLoads, datesBetween, distributeLoads, payloadOptions, splitQuantity, toMilli, type BuildInput, type BuildTruck } from "@/lib/dispatch/load-build";

const truck = (id: string, cap: number | null, extra: Partial<BuildTruck> = {}): BuildTruck => ({
  id, unit_number: id, active: true, service_status: "in_service", weight_capacity: cap, weight_unit: cap === null ? null : "ton",
  volume_capacity: null, capacity_verified_at: "2026-10-01T00:00:00Z", safety_report: false, ...extra,
});
const days = datesBetween("2026-10-12", "2026-10-14");
const base: BuildInput = { unit: "ton", orderedQty: 93, plannedQty: 0, payload: 25, loadsPerDay: 4, mode: "even", days, trucks: [truck("A", 25), truck("B", 25), truck("C", 18)] };
const sum = (q: number[]) => q.reduce((a, b) => a + b, 0);

describe("splitting a quantity into loads", () => {
  it("93 t at 25 t is three full loads and one 18 t load, exactly 93 t", () => {
    const r = buildLoads(base);
    expect(r.ok).toBe(true);
    expect(r.loads.map((l) => l.quantity)).toEqual([25, 25, 25, 18]);
    expect(sum(r.loads.map((l) => toMilli(l.quantity)))).toBe(toMilli(93));
  });

  it("keeps fractional quantities exact to the thousandth", () => {
    const q = splitQuantity(toMilli(50.125), toMilli(22.4));
    expect(q).toEqual([22400, 22400, 5325]);
    expect(sum(q)).toBe(50125);
    const r = buildLoads({ ...base, orderedQty: 0.3, plannedQty: 0.1, payload: 0.1 });
    expect(r.loads.map((l) => l.quantity)).toEqual([0.1, 0.1]); // no floating-point leftover load
  });

  it("plans only what is not on a load yet, and never over-delivers", () => {
    const r = buildLoads({ ...base, plannedQty: 50 });
    expect(r.loads.map((l) => l.quantity)).toEqual([25, 18]);
    const done = buildLoads({ ...base, plannedQty: 93 });
    expect(done.ok).toBe(false);
    expect(done.loads).toEqual([]);
    const over = buildLoads({ ...base, plannedQty: 100 });
    expect(over.ok).toBe(false);
    expect(over.warnings[0]).toMatch(/more than the 93 t ordered/);
  });

  it("an exact multiple has no partial load", () => {
    expect(splitQuantity(toMilli(75), toMilli(25))).toEqual([25000, 25000, 25000]);
  });
});

describe("capacity and eligibility", () => {
  it("never plans a load larger than a truck that can carry it", () => {
    const r = buildLoads({ ...base, payload: 30 });
    expect(r.ok).toBe(false);
    expect(r.blockers[0]).toMatch(/No in-service truck has a recorded capacity of 30 t or more/);
  });

  it("does not count inactive, out-of-service, unsafe or unknown-capacity trucks", () => {
    const trucks = [
      truck("off", 25, { service_status: "out_of_service" }),
      truck("old", 25, { active: false }),
      truck("broken", 25, { safety_report: true }),
      truck("unknown", null),
      truck("ok", 18),
    ];
    expect(payloadOptions(trucks, "ton")).toEqual([18]);
    const r = buildLoads({ ...base, trucks, payload: 25 });
    expect(r.ok).toBe(false);
    const ok = buildLoads({ ...base, trucks, payload: 18 });
    expect(ok.ok).toBe(true);
    expect(ok.eligibleTrucks).toBe(1);
  });

  it("explains when no truck has a capacity in the order's unit", () => {
    const r = buildLoads({ ...base, unit: "cu_yd", trucks: [truck("A", 25)] });
    expect(r.ok).toBe(false);
    expect(r.blockers[0]).toMatch(/cubic yards/);
  });

  it("compares pounds with tons correctly", () => {
    const lb = truck("L", 50000, { weight_unit: "lb" }); // 25 t
    expect(payloadOptions([lb], "ton")).toEqual([25]);
  });

  it("warns about unverified capacity and too few trucks for the daily count", () => {
    const r = buildLoads({ ...base, trucks: [truck("A", 25, { capacity_verified_at: null })], loadsPerDay: 2 });
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/unverified capacity/);
    expect(r.warnings.join(" ")).toMatch(/only 1 truck can carry/);
  });
});

describe("spreading loads over the order's dates", () => {
  it("spreads evenly across the window instead of crowding the first day", () => {
    expect(distributeLoads(4, days, 4, "even")).toEqual(["2026-10-12", "2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(distributeLoads(4, days, 4, "earliest")).toEqual(["2026-10-12", "2026-10-12", "2026-10-12", "2026-10-12"]);
  });

  it("refuses rather than moving firm dates when the loads do not fit", () => {
    const r = buildLoads({ ...base, loadsPerDay: 1, days: days.slice(0, 2) });
    expect(r.ok).toBe(false);
    expect(r.blockers[0]).toMatch(/4 loads at 1 a day need 4 days; the order is scheduled for 2/);
    expect(distributeLoads(5, days, 1, "even")).toBeNull();
  });

  it("needs scheduled dates and a daily count", () => {
    expect(buildLoads({ ...base, days: [] }).blockers.join(" ")).toMatch(/no scheduled dates/);
    expect(buildLoads({ ...base, loadsPerDay: 0 }).blockers.join(" ")).toMatch(/loads can run per day/);
  });
});
