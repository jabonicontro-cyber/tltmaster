import { describe, expect, it } from "vitest";
import { recommend, type SmartDriver, type SmartInput, type SmartLoad, type SmartTruck } from "@/lib/dispatch/smart";

// Smart Dispatch with dispatch bases (20261120000200): other-base trucks and drivers are excluded with the reason
// unless the company allows cross-base dispatch; then they are proposed with a warning, after same-base ones.

const TODAY = "2026-10-12";
const at = (hhmm: string) => `${TODAY}T${hhmm}:00.000Z`;
const driver = (name: string, base: string): SmartDriver => ({
  id: "d-" + name, name, active: true, base_id: base,
  qualifications: [
    { kind: "cdl", cdl_class: "A", expires_on: "2028-01-01", verified_at: "2026-01-01T00:00:00Z" },
    { kind: "medical_card", cdl_class: null, expires_on: "2027-06-01", verified_at: "2026-01-01T00:00:00Z" },
  ],
});
const truck = (unit: string, base: string): SmartTruck => ({
  id: "t-" + unit, unit_number: unit, truck_type: "tri_axle_dump", active: true, service_status: "in_service", expected_return_date: null,
  weight_capacity: 22, weight_unit: "ton", volume_capacity: null, capacity_verified_at: "2026-01-01T00:00:00Z", base_id: base,
});
const load: SmartLoad = {
  id: "L", order_id: "o-L", order_number: "O-1", customer_name: "Customer (test)", site: "1 Site Rd", load_number: 1, load_date: TODAY,
  starts_at: at("13:00"), ends_at: at("14:00"), planned_quantity: 20, unit_code: "ton", requested_date: null, urgent: false, needed_by: null, base_id: "north",
};
const names = { north: "North Yard", south: "South Yard" };
const input = (over: Partial<SmartInput>): SmartInput => ({ today: TODAY, loads: [load], bookings: [], trucks: [], drivers: [], truckReports: [], rejections: [], ...over });

describe("Smart Dispatch and dispatch bases", () => {
  it("cross-base off: other-base trucks and drivers are excluded, with the reason", () => {
    const [p] = recommend(input({ trucks: [truck("S1", "south")], drivers: [driver("Sam", "south")], bases: { crossBase: false, names } }));
    expect(p.proposal).toBeNull();
    expect(p.excludedTrucks[0].reasons.join(" ")).toMatch(/Based at South Yard; this load is dispatched from North Yard, and cross-base dispatch is off/);
    expect(p.excludedDrivers[0].reasons.join(" ")).toMatch(/Based at South Yard/);
  });

  it("cross-base off: a same-base pair is proposed and the other base is never suggested", () => {
    const [p] = recommend(input({ trucks: [truck("S1", "south"), truck("N1", "north")], drivers: [driver("Sam", "south"), driver("Nia", "north")], bases: { crossBase: false, names } }));
    expect(p.proposal).toMatchObject({ truckLabel: "N1", driverLabel: "Nia" });
    expect(p.alternatives.every((a) => a.truckLabel !== "S1" && a.driverLabel !== "Sam")).toBe(true);
  });

  it("cross-base on: other-base resources are allowed with a warning, ranked after same-base ones", () => {
    const plans = recommend(input({ trucks: [truck("S1", "south"), truck("N1", "north")], drivers: [driver("Sam", "south"), driver("Nia", "north")], bases: { crossBase: true, names } }));
    expect(plans[0].proposal).toMatchObject({ truckLabel: "N1", driverLabel: "Nia" });
    const [only] = recommend(input({ trucks: [truck("S1", "south")], drivers: [driver("Sam", "south")], bases: { crossBase: true, names } }));
    expect(only.proposal).toMatchObject({ truckLabel: "S1", driverLabel: "Sam" });
    expect(only.proposal!.warnings.join(" ")).toMatch(/From South Yard; this load is dispatched from North Yard/);
  });

  it("without bases (one base, or the update not installed) nothing changes", () => {
    const [p] = recommend(input({ trucks: [truck("S1", "south")], drivers: [driver("Sam", "south")] }));
    expect(p.proposal).toMatchObject({ truckLabel: "S1", driverLabel: "Sam" });
    expect(p.proposal!.warnings.join(" ")).not.toMatch(/Yard/);
  });
});
