import { describe, expect, it } from "vitest";
import type { SmartDriver, SmartLoad, SmartTruck } from "@/lib/dispatch/smart";
import { checkAssignment, feasiblePairs, PRESETS, optimizeWithAlternatives, type OptimizationInput, type OptTrailer } from "@/lib/optimization/plan";

// Plan the day checks the hard rules per part (truck, driver, trailer, pair) instead of per combination. It must agree
// with checkAssignment — the full check used again before an approved assignment — for every combination, including
// tractors with trailers, out-of-service and reported equipment, licences, time off, bookings and rejected pairs.
// Fictional data only.
const DAY = "2026-10-14";
const at = (h: number, m = 0) => `${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const quals = (i: number) => [
  { kind: "cdl" as const, cdl_class: (i % 4 === 3 ? "B" : "A") as "A" | "B", expires_on: i % 7 === 5 ? "2026-01-01" : "2028-01-01", verified_at: i % 6 === 4 ? null : "2026-01-01T00:00:00Z" },
  { kind: "medical_card" as const, cdl_class: null, expires_on: "2027-06-01", verified_at: "2026-01-01T00:00:00Z" },
];

function mixedDay(loads: number, trucks: number, drivers: number, trailerCount: number): OptimizationInput {
  const ls: SmartLoad[] = Array.from({ length: loads }, (_, i) => ({
    id: `l${i}`, order_id: `o${i % 5}`, order_number: `O-${i % 5}`, customer_name: "Customer (test)", site: `site ${i % 4}`, load_number: i,
    load_date: DAY, starts_at: at(6 + (i % 8)), ends_at: at(7 + (i % 8)), planned_quantity: i % 6 === 5 ? null : 14 + (i % 12), unit_code: i % 6 === 5 ? null : "ton",
    requested_date: null, urgent: i % 5 === 0, needed_by: null,
  }));
  const ts: SmartTruck[] = Array.from({ length: trucks }, (_, i) => ({
    id: `t${i}`, unit_number: String(100 + i), truck_type: i % 3 === 0 ? "tractor" : "tri_axle_dump", active: i % 11 !== 7,
    service_status: i % 9 === 4 ? "out_of_service" : "in_service", expected_return_date: null,
    weight_capacity: i % 3 === 0 ? 10 : 16 + (i % 6), weight_unit: "ton", volume_capacity: null, capacity_verified_at: i % 5 ? "2026-01-01T00:00:00Z" : null,
  }));
  const ds: SmartDriver[] = Array.from({ length: drivers }, (_, i) => ({ id: `d${i}`, name: `Driver ${i}`, active: i % 13 !== 6, qualifications: quals(i) }));
  const trailers: OptTrailer[] = Array.from({ length: trailerCount }, (_, i) => ({
    id: `tr${i}`, unit_number: `T${i}`, active: i % 7 !== 6, service_status: i % 5 === 3 ? "out_of_service" : "in_service",
    weight_capacity: 8 + (i % 8), weight_unit: "ton", volume_capacity: null, capacity_verified_at: i % 2 ? "2026-01-01T00:00:00Z" : null,
    compatible_truck_types: i % 4 === 1 ? ["tri_axle_dump"] : i % 4 === 2 ? [] : ["tractor"],
  }));
  return {
    today: "2026-10-13", loads: ls, trucks: ts, drivers: ds, trailers,
    bookings: [
      { load_id: "x1", order_id: "ox", truck_id: "t1", driver_id: "d0", starts_at: at(8), ends_at: at(10), load_date: DAY, site: "site 1" },
      { load_id: "x2", order_id: "ox", truck_id: "t3", driver_id: "d5", starts_at: at(11), ends_at: at(12), load_date: DAY, site: "site 2" },
    ],
    trailerBookings: [{ trailer_id: "tr0", load_id: "x3", starts_at: at(6), ends_at: at(9) }],
    trailerReports: [{ trailer_id: "tr8", kind: "breakdown" }, { trailer_id: "tr9", kind: "equipment_issue" }],
    truckReports: [{ truck_id: "t2", kind: "breakdown" }, { truck_id: "t4", kind: "equipment_issue" }],
    shopVisits: [
      { truck_id: "t5", number: "WO-1", status: "scheduled", scheduled_for: DAY, safety_critical: false },
      { truck_id: "t6", number: "WO-2", status: "open", scheduled_for: null, safety_critical: true },
    ],
    timeOff: [{ driver_id: "d2", status: "approved", starts_at: at(0), ends_at: at(23) }, { driver_id: "d4", status: "pending", starts_at: at(6), ends_at: at(9) }],
    driversOnLeave: ["d7"],
    rejections: [{ load_id: "l1", truck_id: "t7", driver_id: "d1" }, { load_id: "l2", truck_id: "t9", driver_id: "d3" }],
    revenueCents: Object.fromEntries(ls.map((l, i) => [l.id, i % 3 ? 40_000 + i * 500 : null])),
  };
}

describe("Plan the day feasibility", () => {
  it("finds exactly the combinations checkAssignment allows (at most three trailers per tractor and driver)", () => {
    const input = mixedDay(12, 24, 16, 12);
    const pairs = feasiblePairs(input);
    let checked = 0;
    let feasible = 0;
    for (const load of input.loads) {
      const found = pairs.get(load.id) ?? [];
      // Everything proposed passes the full check.
      for (const p of found) expect(checkAssignment(input, load.id, p.truck.id, p.trailer?.id ?? null, p.driverId).ok).toBe(true);
      for (const truck of input.trucks) {
        for (const driver of input.drivers) {
          const proposed = found.filter((p) => p.truck.id === truck.id && p.driverId === driver.id);
          if (truck.truck_type === "tractor") {
            const ok = (input.trailers ?? []).filter((t) => checkAssignment(input, load.id, truck.id, t.id, driver.id).ok).length;
            expect(proposed.length, `${load.id} ${truck.id} ${driver.id}`).toBe(Math.min(ok, 3));
            checked += input.trailers!.length;
          } else {
            expect(proposed.length, `${load.id} ${truck.id} ${driver.id}`).toBe(checkAssignment(input, load.id, truck.id, null, driver.id).ok ? 1 : 0);
            checked++;
          }
          feasible += proposed.length;
        }
      }
    }
    // The fixture exercises both outcomes.
    expect(checked).toBeGreaterThan(10_000);
    expect(feasible).toBeGreaterThan(100);
    expect(feasible).toBeLessThan(checked);
  });

  // The Top Line test company (227 trucks, 149 drivers, 20 loads) took 13 s before the per-part checks and cached
  // score parts (2026-10-13), about 3 s after.
  it("plans 20 loads across 220 trucks and 150 drivers, with every alternative, in seconds", () => {
    const input = mixedDay(20, 220, 150, 12);
    const started = performance.now();
    const out = optimizeWithAlternatives(input, PRESETS.balanced.priorities, "balanced");
    const ms = performance.now() - started;
    console.log(`optimization 20×220×150: ${Math.round(ms)} ms, covered ${out.plans[0].metrics.covered}`);
    expect(out.plans[0].metrics.covered).toBeGreaterThan(15);
    expect(ms).toBeLessThan(10_000);
  }, 120_000);
});
