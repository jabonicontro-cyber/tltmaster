import { describe, expect, it } from "vitest";
import type { SmartDriver, SmartLoad, SmartTruck } from "@/lib/dispatch/smart";
import { PRESETS, checkAssignment, optimize, optimizeWithAlternatives, parsePriorities, tradeoffs, type OptTrailer, type OptimizationInput } from "@/lib/optimization/plan";

// AI Optimization Core, first slice (docs/OPTIMIZATION.md): whole-day plans across trucks and drivers, hard
// constraints first, configurable priorities, explanations and trade-offs. Deterministic; never assigns.

const DAY = "2026-10-14";
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const driver = (name: string, extra: Partial<SmartDriver> = {}): SmartDriver => ({
  id: `d-${name}`, name, active: true,
  qualifications: [
    { kind: "cdl", cdl_class: "A", expires_on: "2028-01-01", verified_at: "2026-01-01T00:00:00Z" },
    { kind: "medical_card", cdl_class: null, expires_on: "2027-06-01", verified_at: "2026-01-01T00:00:00Z" },
  ],
  ...extra,
});
const truck = (unit: string, extra: Partial<SmartTruck> = {}): SmartTruck => ({
  id: `t-${unit}`, unit_number: unit, truck_type: "tri_axle_dump", active: true, service_status: "in_service", expected_return_date: null,
  weight_capacity: 22, weight_unit: "ton", volume_capacity: null, capacity_verified_at: "2026-01-01T00:00:00Z", ...extra,
});
const load = (id: string, extra: Partial<SmartLoad> = {}): SmartLoad => ({
  id, order_id: `o-${id}`, order_number: `O-${id}`, customer_name: "Customer (test)", site: "1 Site Rd", load_number: 1,
  load_date: DAY, starts_at: at("13:00"), ends_at: at("14:00"), planned_quantity: 20, unit_code: "ton",
  requested_date: null, urgent: false, needed_by: null, ...extra,
});
const trailer = (unit: string, extra: Partial<OptTrailer> = {}): OptTrailer => ({
  id: `tr-${unit}`, unit_number: unit, active: true, service_status: "in_service", weight_capacity: 25, weight_unit: "ton", volume_capacity: null,
  capacity_verified_at: "2026-01-01T00:00:00Z", compatible_truck_types: ["tractor"], ...extra,
});
const tractor = (unit: string) => truck(unit, { truck_type: "tractor", weight_capacity: null });
const classB = (name: string) => driver(name, { qualifications: [
  { kind: "cdl", cdl_class: "B", expires_on: "2028-01-01", verified_at: "2026-01-01T00:00:00Z" },
  { kind: "medical_card", cdl_class: null, expires_on: "2027-06-01", verified_at: "2026-01-01T00:00:00Z" },
] });
const input = (over: Partial<OptimizationInput>): OptimizationInput => ({
  today: "2026-10-13", loads: [], bookings: [], trucks: [truck("101")], drivers: [driver("Avery")], truckReports: [], rejections: [],
  revenueCents: {}, ...over,
});

describe("optimization core", () => {
  it("never plans a pair that breaks a hard constraint, however valuable the load", () => {
    const loads = [load("A", { urgent: true })];
    const plan = optimize(input({ loads, trucks: [truck("101", { service_status: "out_of_service" })], revenueCents: { A: 900_00 } }), PRESETS.revenue.priorities);
    expect(plan.assignments).toEqual([]);
    expect(plan.uncovered[0].why).toMatch(/No truck-and-driver pair passes the hard constraints/);
    // A blocked driver (expired medical card) is never used either.
    const expired = driver("Blake", { qualifications: [{ kind: "cdl", cdl_class: "A", expires_on: "2028-01-01", verified_at: "2026-01-01T00:00:00Z" }, { kind: "medical_card", cdl_class: null, expires_on: "2026-01-01", verified_at: "2025-01-01T00:00:00Z" }] });
    const p2 = optimize(input({ loads, drivers: [expired, driver("Avery")] }), PRESETS.balanced.priorities);
    expect(p2.assignments.map((a) => a.driverLabel)).toEqual(["Avery"]);
  });

  it("covers more loads than greedy one-at-a-time when it re-pairs resources across the day", () => {
    // Two overlapping loads; only truck 101 can carry the 30 t load. Greedy-by-value would give 101 to the first.
    const loads = [load("A", { planned_quantity: 18 }), load("B", { planned_quantity: 30 })];
    const trucks = [truck("101", { weight_capacity: 32 }), truck("102", { weight_capacity: 20 })];
    const ctx = input({ loads, trucks, drivers: [driver("Avery"), driver("Blake")] });
    // Without a utilization preference the first pass puts A on 101 (tie → first unit) and leaves B uncovered;
    // the improvement step frees 101 for B and moves A to 102.
    const plan = optimize(ctx, { service: 0, revenue: 0, utilization: 0, efficiency: 0, balance: 0, crews: 0 });
    expect(plan.metrics.covered).toBe(2);
    expect(plan.assignments.find((a) => a.loadId === "B")?.truckLabel).toBe("101");
    expect(plan.assignments.find((a) => a.loadId === "A")?.truckLabel).toBe("102");
  });

  it("never double-books a truck or driver inside the plan", () => {
    const loads = [load("A"), load("B"), load("C", { starts_at: at("15:00"), ends_at: at("16:00") })];
    const plan = optimize(input({ loads, trucks: [truck("101")], drivers: [driver("Avery"), driver("Blake")] }), PRESETS.balanced.priorities);
    expect(plan.metrics.covered).toBe(2); // A or B, plus C later the same day
    expect(plan.assignments.map((a) => a.loadId)).toContain("C");
    expect(plan.uncovered).toHaveLength(1);
    expect(plan.uncovered[0].why).toMatch(/used by a higher-priority load/);
  });

  it("priorities change the plan: service first covers the urgent load, revenue first the larger estimate", () => {
    const loads = [load("U", { urgent: true }), load("R")];
    const base = input({ loads, revenueCents: { U: 300_00, R: 2_000_00 } });
    const service = optimize(base, PRESETS.service.priorities);
    const revenue = optimize(base, { service: 0, revenue: 5, utilization: 0, efficiency: 0, balance: 0, crews: 0 });
    expect(service.assignments.map((a) => a.loadId)).toEqual(["U"]);
    expect(revenue.assignments.map((a) => a.loadId)).toEqual(["R"]);
    expect(tradeoffs(service, revenue)).toEqual(expect.arrayContaining(["1 fewer urgent load(s) covered", "+$1,700 estimated revenue covered"]));
  });

  it("explains each assignment and never calls it verified while hours of service are unknown", () => {
    const plan = optimize(input({ loads: [load("A", { urgent: true })], trucks: [truck("101", { capacity_verified_at: null })], revenueCents: { A: 500_00 } }), PRESETS.balanced.priorities);
    const [a] = plan.assignments;
    expect(a.status).toBe("needs_review");
    expect(a.review).toEqual(expect.arrayContaining(["Hours of service not verified (no ELD or driver-log data).", "Truck 101's capacity is not verified."]));
    expect(a.reasons.join(" ")).toMatch(/urgent order/);
    const verified = optimize(input({ loads: [load("A")], hoursOfServiceVerified: true }), PRESETS.balanced.priorities);
    expect(verified.assignments[0].status).toBe("verified");
  });

  it("a driver whose employee record says On leave is a review note, never a silent pass or an invented block", () => {
    const plan = optimize(input({ loads: [load("A")], hoursOfServiceVerified: true, driversOnLeave: ["d-Avery"] }), PRESETS.balanced.priorities);
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].status).toBe("needs_review");
    expect(plan.assignments[0].review).toContain("The driver's employee record says On leave — confirm they are working that day.");
  });

  it("keeps a truck on one site when efficiency matters, and spreads work when balance matters", () => {
    const loads = [
      load("A", { site: "north pit", starts_at: at("08:00"), ends_at: at("09:00") }),
      load("B", { site: "north pit", starts_at: at("10:00"), ends_at: at("11:00") }),
    ];
    const ctx = input({ loads, trucks: [truck("101"), truck("102")], drivers: [driver("Avery"), driver("Blake")] });
    const eff = optimize(ctx, { service: 0, revenue: 0, utilization: 0, efficiency: 5, balance: 0, crews: 0 });
    expect(new Set(eff.assignments.map((a) => a.truckId)).size).toBe(1);
    const bal = optimize(ctx, { service: 0, revenue: 0, utilization: 0, efficiency: 0, balance: 5, crews: 0 });
    expect(new Set(bal.assignments.map((a) => a.driverId)).size).toBe(2);
    expect(bal.metrics.workloadSpread).toBe(0);
  });

  it("reports missing data, revenue it cannot estimate, alternatives and their trade-offs; deterministic", () => {
    const loads = [load("U", { urgent: true }), load("R")];
    const ctx = input({ loads, revenueCents: { U: null, R: 2_000_00 }, maintenanceChecked: false });
    const out = optimizeWithAlternatives(ctx, PRESETS.service.priorities, "service");
    expect(out.plans[0].label).toBe("Service first");
    expect(out.dataNotes.join(" ")).toMatch(/Hours of service are not checked/);
    expect(out.dataNotes.join(" ")).toMatch(/margin is not evaluated/);
    expect(out.dataNotes.join(" ")).toMatch(/1 load\(s\) have no rate/);
    expect(out.dataNotes.join(" ")).toMatch(/Maintenance shop dates were not checked/);
    expect(out.plans.length).toBeGreaterThanOrEqual(2); // a revenue-first alternative takes R instead of U
    expect(out.tradeoffs[0].differences.join(" ")).toMatch(/urgent/);
    expect(optimizeWithAlternatives(ctx, PRESETS.service.priorities, "service")).toEqual(out);
  });

  it("plans tractors only with a usable trailer, under the database's trailer rules", () => {
    const loads = [load("A", { planned_quantity: 24 })];
    // No trailer: the tractor cannot take the load.
    expect(optimize(input({ loads, trucks: [tractor("T1")] }), PRESETS.balanced.priorities).assignments).toEqual([]);
    // A compatible trailer: tractor + trailer, combined capacity, class A driver.
    const ok = optimize(input({ loads, trucks: [tractor("T1")], trailers: [trailer("E1")] }), PRESETS.balanced.priorities);
    expect(ok.assignments).toHaveLength(1);
    expect(ok.assignments[0]).toMatchObject({ truckLabel: "T1", trailerLabel: "E1", trailerId: "tr-E1" });
    expect(ok.metrics.averageFill).toBeCloseTo(24 / 25);
    // Each rule blocks on its own.
    const blocked = (over: Partial<OptimizationInput>) => optimize(input({ loads, trucks: [tractor("T1")], trailers: [trailer("E1")], ...over }), PRESETS.balanced.priorities).assignments.length;
    expect(blocked({ trailers: [trailer("E1", { compatible_truck_types: ["tri_axle_dump"] })] })).toBe(0); // incompatible
    expect(blocked({ trailers: [trailer("E1", { service_status: "out_of_service" })] })).toBe(0);
    expect(blocked({ trailers: [trailer("E1", { weight_capacity: 20 })] })).toBe(0); // 24 t > 20 t combined
    expect(blocked({ drivers: [classB("Casey")] })).toBe(0); // a trailer needs a class A CDL
    expect(blocked({ trailerReports: [{ trailer_id: "tr-E1", kind: "breakdown" }] })).toBe(0);
    expect(blocked({ trailerBookings: [{ trailer_id: "tr-E1", load_id: "other", starts_at: at("13:30"), ends_at: at("15:00") }] })).toBe(0);
    // Unrecorded compatibility is a warning, as in the database.
    const unknown = optimize(input({ loads, trucks: [tractor("T1")], trailers: [trailer("E1", { compatible_truck_types: [] })] }), PRESETS.balanced.priorities);
    expect(unknown.assignments[0].review).toContain("Trailer E1's compatible truck types are not recorded.");
  });

  it("never gives one trailer to two overlapping loads, and re-checks a trailer assignment on approval", () => {
    const loads = [load("A"), load("B")];
    const ctx = input({ loads, trucks: [tractor("T1"), tractor("T2")], trailers: [trailer("E1")], drivers: [driver("Avery"), driver("Blake")] });
    const plan = optimize(ctx, PRESETS.balanced.priorities);
    expect(plan.metrics.covered).toBe(1);
    const a = plan.assignments[0];
    expect(checkAssignment(ctx, a.loadId, a.truckId, a.trailerId, a.driverId)).toEqual({ ok: true, reasons: [] });
    expect(checkAssignment(ctx, a.loadId, a.truckId, null, a.driverId).reasons[0]).toMatch(/is a tractor: it needs a trailer/);
    const taken = { ...ctx, trailerBookings: [{ trailer_id: "tr-E1", load_id: "x", starts_at: at("12:00"), ends_at: at("14:00") }] };
    expect(checkAssignment(taken, a.loadId, a.truckId, a.trailerId, a.driverId).ok).toBe(false);
  });

  it("parses priorities safely", () => {
    expect(parsePriorities({ service: "9", revenue: "-2", utilization: "x" })).toEqual({ service: 5, revenue: 0, utilization: 3, efficiency: 3, balance: 3, crews: 0 });
  });

  // Keep crews together (master plan §9 Q20, owner 2026-10-13: optional, off by default). Two sequential loads, one
  // truck and two drivers: balancing splits the day between the drivers; raising the setting keeps one driver on the
  // truck, and a driver's primary truck is preferred. It never overrides a hard rule.
  it("keep crews together is off in every preset and, when raised, keeps a driver on one truck and on their primary truck", () => {
    for (const p of Object.values(PRESETS)) expect(p.priorities.crews).toBe(0);
    const loads = [load("A", { starts_at: at("07:00"), ends_at: at("08:00") }), load("B", { starts_at: at("09:00"), ends_at: at("10:00") })];
    const ctx = input({ loads, trucks: [truck("101")], drivers: [driver("Avery"), driver("Blake")] });
    const split = optimize(ctx, { ...PRESETS.balanced.priorities, crews: 0 });
    expect(new Set(split.assignments.map((a) => a.driverLabel)).size).toBe(2); // balance: one load each
    const kept = optimize(ctx, { ...PRESETS.balanced.priorities, crews: 5 });
    expect(new Set(kept.assignments.map((a) => a.driverLabel)).size).toBe(1);
    expect(kept.assignments.flatMap((a) => a.reasons).join(" ")).toMatch(/keeps (Avery|Blake) on truck 101/);

    // Primary truck: with two trucks and one load, Blake's primary truck 102 wins once the setting is raised.
    const one = input({ loads: [load("C")], trucks: [truck("101"), truck("102")], drivers: [driver("Blake", { primary_truck_id: "t-102" })] });
    expect(optimize(one, { ...PRESETS.balanced.priorities, crews: 0 }).assignments[0].truckLabel).toBe("101"); // tie → first unit
    const prim = optimize(one, { ...PRESETS.balanced.priorities, crews: 3 }).assignments[0];
    expect(prim.truckLabel).toBe("102");
    expect(prim.reasons.join(" ")).toMatch(/truck 102 is Blake's primary truck/);

    // A hard rule still wins: the primary truck out of service is never used.
    const broken = input({ loads: [load("C")], trucks: [truck("101"), truck("102", { service_status: "out_of_service" })], drivers: [driver("Blake", { primary_truck_id: "t-102" })] });
    expect(optimize(broken, { ...PRESETS.balanced.priorities, crews: 5 }).assignments[0].truckLabel).toBe("101");
  });
});
