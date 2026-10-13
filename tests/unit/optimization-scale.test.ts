import { describe, expect, it } from "vitest";
import type { SmartDriver, SmartLoad, SmartTruck } from "@/lib/dispatch/smart";
import { PRESETS, optimizeWithAlternatives, type OptimizationInput } from "@/lib/optimization/plan";

// Plan the day must stay responsive for a realistic day: dozens of loads across a mid-size fleet (all presets).
const DAY = "2026-10-14";
const at = (h: number, m = 0) => `${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const quals = [
  { kind: "cdl" as const, cdl_class: "A" as const, expires_on: "2028-01-01", verified_at: "2026-01-01T00:00:00Z" },
  { kind: "medical_card" as const, cdl_class: null, expires_on: "2027-06-01", verified_at: "2026-01-01T00:00:00Z" },
];

function bigDay(loads: number, trucks: number, drivers: number): OptimizationInput {
  const ls: SmartLoad[] = Array.from({ length: loads }, (_, i) => ({
    id: `l${i}`, order_id: `o${i % 12}`, order_number: `O-${i % 12}`, customer_name: "Customer (test)", site: `site ${i % 6}`, load_number: i,
    load_date: DAY, starts_at: at(6 + (i % 10), (i * 7) % 60), ends_at: at(7 + (i % 10), (i * 7) % 60), planned_quantity: 14 + (i % 8), unit_code: "ton",
    requested_date: i % 9 === 0 ? "2026-10-13" : null, urgent: i % 11 === 0, needed_by: null,
  }));
  const ts: SmartTruck[] = Array.from({ length: trucks }, (_, i) => ({
    id: `t${i}`, unit_number: String(100 + i), truck_type: "tri_axle_dump", active: true, service_status: "in_service", expected_return_date: null,
    weight_capacity: 18 + (i % 6), weight_unit: "ton", volume_capacity: null, capacity_verified_at: i % 5 ? "2026-01-01T00:00:00Z" : null,
  }));
  const ds: SmartDriver[] = Array.from({ length: drivers }, (_, i) => ({ id: `d${i}`, name: `Driver ${i}`, active: true, qualifications: quals }));
  return { today: "2026-10-13", loads: ls, bookings: [], trucks: ts, drivers: ds, truckReports: [], rejections: [], revenueCents: Object.fromEntries(ls.map((l, i) => [l.id, i % 4 ? 50_000 + i * 1000 : null])) };
}

describe("optimization at fleet scale", () => {
  it("plans 40 loads across 20 trucks and 20 drivers, with every alternative, in a few seconds", () => {
    const started = performance.now();
    const out = optimizeWithAlternatives(bigDay(40, 20, 20), PRESETS.balanced.priorities, "balanced");
    const ms = performance.now() - started;
    console.log(`optimization 40×20×20: ${Math.round(ms)} ms, ${out.plans.length} plans, covered ${out.plans[0].metrics.covered}`);
    expect(out.plans[0].metrics.covered).toBeGreaterThan(30);
    expect(ms).toBeLessThan(8000);
  }, 60_000);
});
