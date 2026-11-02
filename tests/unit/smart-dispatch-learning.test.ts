// Smart Dispatch learns from recorded decisions (B117): a driver or truck dispatchers rejected for a customer at least
// twice ranks lower for that customer, with the reason shown; a driver who ran that customer's loads ranks higher.
// One rejection teaches nothing; other customers are unaffected; nothing is ever excluded by learning.
import { describe, expect, it } from "vitest";
import { learnedAdjustment, recommend, type SmartDriver, type SmartInput, type SmartLoad, type SmartTruck } from "@/lib/dispatch/smart";

const TODAY = "2026-10-12";
const driver = (id: string, name: string): SmartDriver => ({
  id, name, active: true,
  qualifications: [
    { kind: "cdl", cdl_class: "B", expires_on: "2030-01-01", verified_at: "2026-01-01" },
    { kind: "medical_card", cdl_class: null, expires_on: "2030-01-01", verified_at: "2026-01-01" },
  ],
});
const truck: SmartTruck = { id: "t-1", unit_number: "101", truck_type: "tri_axle_dump", active: true, service_status: "in_service", expected_return_date: null, weight_capacity: null, weight_unit: null, volume_capacity: null, capacity_verified_at: null };
const load: SmartLoad = { id: "L", order_id: "o", order_number: "ORD-1", customer_name: "Harlow Homes", customer_id: "c-h", site: "s", load_number: 1, load_date: TODAY, starts_at: `${TODAY}T13:00:00Z`, ends_at: `${TODAY}T14:00:00Z`, planned_quantity: null, unit_code: null, requested_date: null, urgent: false, needed_by: null };
const input = (learned: SmartInput["learned"]): SmartInput => ({ today: TODAY, loads: [load], bookings: [], trucks: [truck], drivers: [driver("d-a", "Avery"), driver("d-b", "Blake")], truckReports: [], rejections: [], learned });
const empty = { driverRejected: {}, truckRejected: {}, driverWorked: {} };

describe("learning from dispatcher decisions", () => {
  it("rejections push down from the second one; experience pushes up", () => {
    expect(learnedAdjustment("driver", "d-a", load, { ...empty, driverRejected: { "d-a|c-h": 1 } }).score).toBe(0);
    const r = learnedAdjustment("driver", "d-a", load, { ...empty, driverRejected: { "d-a|c-h": 3 } });
    expect(r.score).toBe(-18);
    expect(r.reason).toBe("Dispatchers passed on this driver for Harlow Homes 3 times recently.");
    expect(learnedAdjustment("driver", "d-a", load, { ...empty, driverWorked: { "d-a|c-h": 4 } })).toEqual({ score: 8, reason: "Has run 4 loads for Harlow Homes (knows the site)." });
    expect(learnedAdjustment("driver", "d-a", { ...load, customer_id: "other" }, { ...empty, driverRejected: { "d-a|c-h": 5 } }).score).toBe(0);
    expect(learnedAdjustment("driver", "d-a", load, undefined).score).toBe(0);
  });

  it("changes the proposal but never removes the option", () => {
    const base = recommend(input(empty))[0];
    expect(base.proposal!.driverId).toBe("d-a"); // alphabetical tie-break
    const learned = recommend(input({ ...empty, driverRejected: { "d-a|c-h": 2 } }))[0];
    expect(learned.proposal!.driverId).toBe("d-b");
    expect(learned.alternatives.some((c) => c.driverId === "d-a" && c.reasons.some((x) => /passed on this driver/.test(x)))).toBe(true);
    const experienced = recommend(input({ ...empty, driverWorked: { "d-b|c-h": 3 } }))[0];
    expect(experienced.proposal!.driverId).toBe("d-b");
  });
});

describe("priority customers", () => {
  it("plans a priority customer's load first, right after urgent ones, with the reason", () => {
    const later = { ...load, id: "P", order_number: "ORD-2", starts_at: `${TODAY}T15:00:00Z`, ends_at: `${TODAY}T16:00:00Z`, priority_customer: true };
    const urgent = { ...load, id: "U", order_number: "ORD-3", starts_at: `${TODAY}T17:00:00Z`, ends_at: `${TODAY}T18:00:00Z`, urgent: true };
    const plans = recommend({ ...input(empty), loads: [load, later, urgent], drivers: [driver("d-a", "Avery")] });
    expect(plans.map((p) => p.load.id)).toEqual(["U", "P", "L"]);
    expect(plans[1].priority.reasons[0]).toBe("Priority customer");
    // With one driver, the priority load gets them before the ordinary load at an overlapping time.
    const clash = { ...later, starts_at: load.starts_at, ends_at: load.ends_at };
    const two = recommend({ ...input(empty), loads: [load, clash], drivers: [driver("d-a", "Avery")], trucks: [truck] });
    expect(two.find((p) => p.load.id === "P")!.proposal).not.toBeNull();
    expect(two.find((p) => p.load.id === "L")!.proposal).toBeNull();
  });
});
