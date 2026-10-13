import { describe, expect, it } from "vitest";
import type { SmartDriver, SmartLoad, SmartTruck } from "@/lib/dispatch/smart";
import { explainLoad, unavailableResources } from "@/lib/optimization/availability";
import { PRESETS, optimizeWithAlternatives, type OptTrailer, type OptimizationInput } from "@/lib/optimization/plan";

// Plan the day explains blocked loads and unavailable resources from the same hard rules the optimizer applies
// (src/lib/optimization/availability.ts). It adds no rule and decides nothing.

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
const input = (over: Partial<OptimizationInput>): OptimizationInput => ({
  today: "2026-10-13", loads: [], bookings: [], trucks: [truck("101")], drivers: [driver("Avery")], truckReports: [], rejections: [],
  revenueCents: {}, ...over,
});

const expiredMed = (name: string) => driver(name, { qualifications: [
  { kind: "cdl", cdl_class: "A", expires_on: "2028-01-01", verified_at: "2026-01-01T00:00:00Z" },
  { kind: "medical_card", cdl_class: null, expires_on: "2026-01-01", verified_at: "2025-01-01T00:00:00Z" },
] });

describe("Plan the day: why loads are blocked and what is unavailable", () => {
  it("names the truck and driver that cannot work, with the rule, and lists them as unavailable all day", () => {
    const ctx = input({
      loads: [load("A"), load("B", { starts_at: at("15:00"), ends_at: at("16:00") })],
      trucks: [truck("101", { service_status: "out_of_service", expected_return_date: "2026-10-16" })],
      drivers: [expiredMed("Blake")],
    });
    const result = optimizeWithAlternatives(ctx, PRESETS.balanced.priorities, "balanced");
    expect(result.plans[0].assignments).toEqual([]); // nothing infeasible is ever proposed
    expect(result.blocked.map((b) => b.loadId)).toEqual(["A", "B"]);
    const ex = explainLoad(ctx, "A");
    expect(ex.summary).toMatch(/None of the 1 truck can take this load/);
    expect(ex.unavailable).toEqual([
      { kind: "truck", id: "t-101", label: "Truck 101", reasons: [expect.stringMatching(/Out of service \(expected back 2026-10-16\)/)] },
      { kind: "driver", id: "d-Blake", label: "Blake", reasons: [expect.stringMatching(/medical/i)] },
    ]);
    expect(unavailableResources(ctx).map((u) => u.label)).toEqual(["Truck 101", "Blake"]);
  });

  it("a resource busy for only part of the day is not listed as unavailable all day", () => {
    const ctx = input({
      loads: [load("A"), load("B", { starts_at: at("15:00"), ends_at: at("16:00") })],
      bookings: [{ load_id: "X", order_id: "o-X", truck_id: "t-101", driver_id: "d-Other", load_date: DAY, starts_at: at("12:30"), ends_at: at("14:30"), site: "Elsewhere" }],
    });
    expect(explainLoad(ctx, "A").unavailable.map((u) => u.label)).toEqual(["Truck 101"]);
    expect(explainLoad(ctx, "B").unavailable).toEqual([]);
    expect(unavailableResources(ctx)).toEqual([]);
  });

  it("tractors: explains trailers that are booked or out of service, without the tractor-only messages", () => {
    const ctx = input({
      loads: [load("A")],
      trucks: [tractor("201")],
      trailers: [trailer("T-51", { service_status: "out_of_service" }), trailer("T-52")],
      trailerBookings: [{ trailer_id: "tr-T-52", load_id: "Y", starts_at: at("12:00"), ends_at: at("15:00") }],
    });
    const ex = explainLoad(ctx, "A");
    expect(ex.summary).toMatch(/Every free truck is a tractor and none of the 2 trailers are free/);
    expect(ex.unavailable.map((u) => [u.label, u.reasons])).toEqual([
      ["Trailer T-51", ["Out of service."]],
      ["Trailer T-52", ["Already booked at an overlapping time."]],
    ]);
    expect(ex.unavailable.some((u) => u.reasons.some((r) => /needs a trailer/.test(r)))).toBe(false);
  });

  it("when each resource is free on its own, says the combination fails (capacity) instead of inventing a reason", () => {
    const ctx = input({ loads: [load("A", { planned_quantity: 30 })], trucks: [truck("101", { weight_capacity: 22 })] });
    const ex = explainLoad(ctx, "A");
    // The truck's own capacity rule names it; nothing else is claimed.
    expect(ex.unavailable).toEqual([{ kind: "truck", id: "t-101", label: "Truck 101", reasons: [expect.stringMatching(/exceeds its recorded capacity/)] }]);
    const free = explainLoad(input({ loads: [load("A")], drivers: [driver("Avery")], rejections: [{ load_id: "A", truck_id: "t-101", driver_id: "d-Avery" }] }), "A");
    expect(free.unavailable).toEqual([]);
    expect(free.summary).toMatch(/free on their own, but no combination passes every rule/);
  });

  it("no trucks or no drivers at all is said plainly", () => {
    expect(explainLoad(input({ loads: [load("A")], trucks: [] }), "A").summary).toBe("There are no active trucks.");
    expect(explainLoad(input({ loads: [load("A")], drivers: [] }), "A").summary).toBe("There are no active drivers.");
    expect(unavailableResources(input({ loads: [] }))).toEqual([]);
  });
});
