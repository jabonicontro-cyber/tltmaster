import { describe, expect, it } from "vitest";
import { bookingsFor, capacityProblem, combinationCheck, conflictsFor, driverState, inShop, minutes, overlaps, shiftDate, trailerState, truckState, type ActiveAssignment, type DayContext, type DayRestrictions } from "@/lib/dispatch/board";

const ON = "2026-10-20";
const at = (h: string) => `${ON}T${h}:00-05:00`;
const iv = (a: string, b: string) => ({ starts_at: at(a), ends_at: at(b) });
const V = "2026-01-01T00:00:00Z";

const booking = (id: string, start: string, end: string, extra: Partial<ActiveAssignment> = {}): ActiveAssignment => ({
  id,
  load_id: `load-${id}`,
  truck_id: "T1",
  trailer_id: null,
  driver_id: "D1",
  status: "active",
  ...iv(start, end),
  ...extra,
});

const truck = { id: "T1", active: true, service_status: "in_service" as const, truck_type: "tri_axle_dump" as const, weight_capacity: 22, volume_capacity: null, capacity_verified_at: V };
const tractor = { ...truck, id: "T2", truck_type: "tractor" as const };
const trailer = { id: "R1", active: true, service_status: "in_service" as const, compatible_truck_types: ["tractor" as const], weight_capacity: null, volume_capacity: 24, capacity_verified_at: V };
const quals = (cls: "A" | "B") => [
  { kind: "cdl" as const, cdl_class: cls, expires_on: "2028-01-01", verified_at: V },
  { kind: "medical_card" as const, cdl_class: null, expires_on: "2028-01-01", verified_at: V },
];
const driver = { id: "D1", active: true, qualifications: quals("A") };

describe("intervals", () => {
  it("treats intervals as half-open: back-to-back does not overlap", () => {
    expect(overlaps(iv("07:00", "09:00"), iv("08:59", "10:00"))).toBe(true);
    expect(overlaps(iv("07:00", "09:00"), iv("09:00", "10:00"))).toBe(false);
    expect(overlaps(iv("09:00", "10:00"), iv("07:00", "09:00"))).toBe(false);
    expect(overlaps(iv("07:00", "12:00"), iv("08:00", "09:00"))).toBe(true);
  });

  it("finds conflicts per resource, ignoring canceled rows and the assignment being replaced", () => {
    const list = [booking("a", "07:00", "09:00"), booking("b", "10:00", "11:00", { status: "canceled" }), booking("c", "12:00", "13:00", { truck_id: "T9" })];
    expect(conflictsFor(list, "truck", "T1", iv("08:00", "12:30")).map((a) => a.id)).toEqual(["a"]);
    expect(conflictsFor(list, "truck", "T1", iv("08:00", "12:30"), "a")).toEqual([]);
    expect(conflictsFor(list, "driver", "D1", iv("12:00", "12:30")).map((a) => a.id)).toEqual(["c"]);
    expect(bookingsFor(list, "truck", "T1").map((a) => a.id)).toEqual(["a"]);
  });
});

describe("resource states", () => {
  const list = [booking("a", "07:00", "09:00")];
  it("separates unavailable from already assigned", () => {
    expect(truckState({ ...truck, service_status: "out_of_service" }, iv("08:00", "09:00"), list, ON)).toEqual({ state: "unavailable", reasons: ["truck_out_of_service"] });
    expect(truckState(truck, iv("08:00", "09:00"), list, ON).state).toBe("busy");
    expect(truckState(truck, iv("09:00", "10:00"), list, ON)).toEqual({ state: "available", warnings: [] });
    expect(trailerState({ ...trailer, active: false }, iv("09:00", "10:00"), list, ON).state).toBe("unavailable");
  });

  it("requires class A for drivers when a trailer is included", () => {
    const b = { ...driver, id: "D2", qualifications: quals("B") };
    expect(driverState(b, false, iv("09:00", "10:00"), list, ON).state).toBe("available");
    expect(driverState(b, true, iv("09:00", "10:00"), list, ON)).toEqual({ state: "unavailable", reasons: ["cdl_class_insufficient"] });
    expect(driverState(driver, false, iv("08:00", "10:00"), list, ON).state).toBe("busy");
  });

  it("checks a combination: tractor needs a trailer, conflicts are listed separately from blockers", () => {
    expect(combinationCheck({ truck: tractor, driver: { ...driver, id: "D3" } }, iv("09:00", "10:00"), list, ON).blockers).toEqual(["trailer_required"]);
    const ok = combinationCheck({ truck: tractor, trailer, driver: { ...driver, id: "D3" } }, iv("09:00", "10:00"), list, ON);
    expect(ok).toMatchObject({ eligible: true, blockers: [], conflicts: [] });
    const busy = combinationCheck({ truck, driver }, iv("08:00", "10:00"), list, ON);
    expect(busy.eligible).toBe(false);
    expect(busy.blockers).toEqual([]);
    expect(busy.conflicts.map((c) => c.kind)).toEqual(["truck", "driver"]);
  });
});

describe("the shown date's restrictions (B1: agree with the server before it refuses)", () => {
  const small = { ...truck, id: "T7", truck_type: "single_axle_dump" as const, weight_capacity: 8 };
  const none: DayRestrictions = { shop: [], reports: [], documents: [], timeOff: [], shifts: [] };
  const load = { load_date: ON, ...iv("13:00", "14:30"), planned_quantity: "22", unit_code: "ton" };
  const ctx = (r: Partial<DayRestrictions> = {}): DayContext => ({ load, restrictions: { ...none, ...r } });

  it("refuses a truck too small for the load, in the server's words, and counts the trailer's capacity", () => {
    const words = "The load is planned at 22 ton, more than the recorded capacity of 8 ton. Split the load or choose larger equipment.";
    expect(capacityProblem([small], 22, "ton")).toBe(words);
    expect(truckState(small, iv("13:00", "14:30"), [], ON, null, ctx())).toEqual({ state: "unavailable", reasons: [words] });
    const check = combinationCheck({ truck: small, driver }, iv("13:00", "14:30"), [], ON, null, ctx());
    expect(check.eligible).toBe(false);
    expect(check.blockers).toEqual([words]);
    // 8 ton + 16 ton trailer carries 22 ton; pounds convert; volume loads compare cubic yards; unknown capacity is not refused.
    expect(capacityProblem([small, { weight_capacity: 16, weight_unit: "ton", volume_capacity: null }], 22, "ton")).toBeNull();
    expect(capacityProblem([{ weight_capacity: 40000, weight_unit: "lb", volume_capacity: null }], 22, "ton")).toContain("capacity of 20 ton");
    expect(capacityProblem([{ weight_capacity: null, volume_capacity: 12 }], 14, "cu_yd")).toContain("capacity of 12 cu yd");
    expect(capacityProblem([{ weight_capacity: null, volume_capacity: null }], 22, "ton")).toBeNull();
    expect(capacityProblem([small], 22, "load")).toBeNull();
    expect(truckState(truck, iv("13:00", "14:30"), [], ON, null, ctx()).state).toBe("available");
    // A tractor's capacity is judged with its trailer.
    expect(truckState({ ...tractor, weight_capacity: 0 }, iv("13:00", "14:30"), [], ON, null, ctx()).state).toBe("available");
  });

  it("marks trucks with a shop visit that day or a safety-critical work order, and warns on shop work in progress", () => {
    const visit = { truck_id: "T1", trailer_id: null, number: "WO-7", status: "scheduled", scheduled_for: ON, safety_critical: false };
    expect(truckState(truck, iv("13:00", "14:30"), [], ON, null, ctx({ shop: [visit] }))).toEqual({ state: "unavailable", reasons: ["truck_shop_scheduled"] });
    expect(inShop("truck", "T1", ON, { ...none, shop: [visit] })).toBe(true);
    expect(inShop("truck", "T1", shiftDate(ON, 1), { ...none, shop: [visit] })).toBe(false);
    expect(truckState(truck, iv("13:00", "14:30"), [], ON, null, ctx({ shop: [{ ...visit, scheduled_for: null, safety_critical: true }] }))).toEqual({ state: "unavailable", reasons: ["truck_safety_restricted"] });
    expect(truckState(truck, iv("13:00", "14:30"), [], ON, null, ctx({ shop: [{ ...visit, scheduled_for: null, status: "in_progress" }] }))).toEqual({ state: "available", warnings: ["truck_shop_work_open"] });
    // Reports and documents follow the database's rules too.
    expect(truckState(truck, iv("13:00", "14:30"), [], ON, null, ctx({ reports: [{ equipment: "truck", truck_id: "T1", trailer_id: null, kind: "breakdown" }] })).state).toBe("unavailable");
    expect(trailerState(trailer, iv("13:00", "14:30"), [], ON, null, ctx({ documents: [{ truck_id: null, trailer_id: "R1", blocks: false }] }))).toEqual({ state: "available", warnings: ["trailer_document_review"] });
  });

  it("refuses approved full-day time off and asks for a reason when the driver is off shift", () => {
    const off = ctx({ timeOff: [{ driver_id: "D1", status: "approved", full_day: true, start_date: ON, end_date: ON }] });
    expect(driverState(driver, false, iv("13:00", "14:30"), [], ON, null, off)).toEqual({ state: "unavailable", reasons: ["driver_time_off"] });
    const dayOff = ctx({ shifts: [{ driver_id: "D1", date: ON, status: "off", start_at: null, end_at: null, label: "" }] });
    const s = driverState(driver, false, iv("13:00", "14:30"), [], ON, null, dayOff);
    expect(s).toEqual({ state: "available", warnings: [], needsReason: "Day off on Tue, Oct 20" });
    const check = combinationCheck({ truck, driver }, iv("13:00", "14:30"), [], ON, null, dayOff);
    expect(check).toMatchObject({ eligible: true, needsReason: "Day off on Tue, Oct 20" });
    // Without the day's data nothing extra is claimed (the server still checks).
    expect(combinationCheck({ truck: small, driver }, iv("13:00", "14:30"), [], ON)).toMatchObject({ eligible: true, needsReason: null });
  });
});

describe("helpers", () => {
  it("converts times and shifts dates", () => {
    expect(minutes("07:30:00")).toBe(450);
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });
});
