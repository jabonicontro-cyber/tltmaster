// Profit-aware dispatch (B113, owner 2026-11-02): fewer empty miles rank first. Miles are straight-line from the truck's
// previous drop that day (or the yard) to the job site; unknown locations leave the ranking as it was.
import { describe, expect, it } from "vitest";
import { emptyMilesFor, recommend, type SmartDriver, type SmartInput, type SmartLoad, type SmartTruck } from "@/lib/dispatch/smart";

const TODAY = "2026-10-12";
const at = (hhmm: string) => `${TODAY}T${hhmm}:00.000Z`;
const driver = (id: string): SmartDriver => ({
  id, name: `Driver ${id}`, active: true,
  qualifications: [
    { kind: "cdl", cdl_class: "B", expires_on: "2030-01-01", verified_at: "2026-01-01" },
    { kind: "medical_card", cdl_class: null, expires_on: "2030-01-01", verified_at: "2026-01-01" },
  ],
});
const truck = (unit: string): SmartTruck => ({ id: `t-${unit}`, unit_number: unit, truck_type: "tri_axle_dump", active: true, service_status: "in_service", expected_return_date: null, weight_capacity: null, weight_unit: null, volume_capacity: null, capacity_verified_at: null });
const NEAR = { lat: 40.42, lng: -86.9 };
const FAR = { lat: 41.2, lng: -86.9 }; // ~54 miles north
const SITE = { lat: 40.45, lng: -86.9 };
const load: SmartLoad = { id: "L", order_id: "o-L", order_number: "ORD-9", customer_name: "C", site: "new site", load_number: 1, load_date: TODAY, starts_at: at("13:00"), ends_at: at("14:00"), planned_quantity: null, unit_code: null, requested_date: null, urgent: false, needed_by: null, point: SITE };
const input = (over: Partial<SmartInput>): SmartInput => ({ today: TODAY, loads: [load], bookings: [], trucks: [truck("101"), truck("102")], drivers: [driver("a")], truckReports: [], rejections: [], ...over });

describe("empty miles", () => {
  it("measures from the previous drop that day, else the yard; unknown points give nothing", () => {
    const prior = [{ truck_id: "t", driver_id: "d", order_id: "o", site: "s", load_date: TODAY, ends_at: at("12:00"), point: FAR }];
    expect(Math.round(emptyMilesFor(prior, load, NEAR)!.miles)).toBe(52);
    expect(emptyMilesFor(prior, load, NEAR)!.from).toBe("previous drop");
    expect(emptyMilesFor([], load, NEAR)).toMatchObject({ from: "yard" });
    expect(Math.round(emptyMilesFor([], load, NEAR)!.miles)).toBe(2);
    expect(emptyMilesFor([], { ...load, point: null }, NEAR)).toBeNull();
    expect(emptyMilesFor([], load, null)).toBeNull();
    // A later booking does not count; a previous drop without a point gives no estimate.
    expect(emptyMilesFor([{ ...prior[0], ends_at: at("15:00") }], load, NEAR)!.from).toBe("yard");
    expect(emptyMilesFor([{ ...prior[0], point: null }], load, NEAR)).toBeNull();
  });

  it("proposes the truck with fewer empty miles and shows its estimated cost", () => {
    // Truck 101 ended its morning far away; 102 starts at the nearby yard.
    const bookings = [{ load_id: "X", order_id: "o-X", truck_id: "t-101", driver_id: "d-other", load_date: TODAY, starts_at: at("09:00"), ends_at: at("10:00"), site: "far site", point: FAR }];
    const [p] = recommend(input({ bookings, yard: NEAR, mileCents: 150 }));
    expect(p.proposal!.truckId).toBe("t-102");
    expect(p.proposal!.emptyMiles).toBeCloseTo(2.1, 0);
    expect(p.proposal!.emptyCostCents).toBe(Math.round(p.proposal!.emptyMiles! * 150));
    expect(p.proposal!.reasons.some((r) => /empty mi from the yard/.test(r))).toBe(true);
    expect(p.notes[0]).toMatch(/straight-line estimates/);
  });

  it("without a cost per mile shows miles only; without locations nothing changes", () => {
    const [p] = recommend(input({ yard: NEAR }));
    expect(p.proposal!.emptyMiles).not.toBeNull();
    expect(p.proposal!.emptyCostCents).toBeNull();
    const [q] = recommend(input({ loads: [{ ...load, point: null }], yard: NEAR, mileCents: 150 }));
    expect(q.proposal!.emptyMiles).toBeNull();
    expect(q.notes[0]).toMatch(/not located yet/);
  });
});
