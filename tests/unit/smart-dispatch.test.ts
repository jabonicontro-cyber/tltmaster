import { describe, expect, it } from "vitest";
import { recommend, type SmartDriver, type SmartInput, type SmartLoad, type SmartTruck } from "@/lib/dispatch/smart";
import { pickTrailer, type OptimizationInput, type OptTrailer } from "@/lib/optimization/plan";

// Smart Dispatch scenarios (engine level). The approval path and its database
// re-checks are covered in tests/db/smart-dispatch.test.ts and the browser test.

const TODAY = "2026-10-12";
const at = (date: string, hhmm: string) => `${date}T${hhmm}:00.000Z`;
const qualified = (extra: Partial<SmartDriver> = {}): SmartDriver => ({
  id: "d-" + (extra.name ?? "x"), name: "x", active: true,
  qualifications: [
    { kind: "cdl", cdl_class: "A", expires_on: "2028-01-01", verified_at: "2026-01-01T00:00:00Z" },
    { kind: "medical_card", cdl_class: null, expires_on: "2027-06-01", verified_at: "2026-01-01T00:00:00Z" },
  ],
  ...extra,
});
const truck = (unit: string, extra: Partial<SmartTruck> = {}): SmartTruck => ({
  id: "t-" + unit, unit_number: unit, truck_type: "tri_axle_dump", active: true, service_status: "in_service", expected_return_date: null,
  weight_capacity: 22, weight_unit: "ton", volume_capacity: null, capacity_verified_at: "2026-01-01T00:00:00Z", ...extra,
});
const load = (id: string, extra: Partial<SmartLoad> = {}): SmartLoad => ({
  id, order_id: "o-" + id, order_number: "O-" + id, customer_name: "Customer (test)", site: "1 Site Rd", load_number: 1,
  load_date: TODAY, starts_at: at(TODAY, "13:00"), ends_at: at(TODAY, "14:00"), planned_quantity: 20, unit_code: "ton",
  requested_date: null, urgent: false, needed_by: null, ...extra,
});
const input = (over: Partial<SmartInput>): SmartInput => ({
  today: TODAY, loads: [], bookings: [], trucks: [truck("101")], drivers: [qualified({ id: "d-avery", name: "Avery" })], truckReports: [], rejections: [], ...over,
});

describe("Smart Dispatch recommendations", () => {
  it("1. proposes a feasible truck and driver, with reasons, and never assigns", () => {
    const [p] = recommend(input({ loads: [load("A")] }));
    expect(p.proposal).toMatchObject({ truckLabel: "101", driverLabel: "Avery" });
    expect(p.proposal!.reasons.join(" ")).toMatch(/Uses 91% of its recorded capacity/);
    expect(p.blocked).toBeNull();
    expect(p.notes[0]).toMatch(/Travel distance is not calculated/);
  });

  it("2. competing jobs: the earlier/urgent load gets the only truck; the other is told why", () => {
    const urgent = load("U", { urgent: true, order_number: "O-2" });
    const routine = load("R", { order_number: "O-1" });
    const plans = recommend(input({ loads: [routine, urgent] }));
    expect(plans.map((p) => p.load.id)).toEqual(["U", "R"]);
    expect(plans[0].proposal?.truckLabel).toBe("101");
    expect(plans[1].proposal).toBeNull();
    expect(plans[1].excludedTrucks[0].reasons[0]).toMatch(/Proposed for O-2 load 1, which is more urgent or earlier/);
  });

  it("3. several eligible trucks: prefers the one already on the job, then the better capacity fit", () => {
    const trucks = [truck("101", { weight_capacity: 40 }), truck("102"), truck("103")];
    const bookings = [{ load_id: "earlier", order_id: "o-A", truck_id: "t-103", driver_id: "d-other", load_date: TODAY, starts_at: at(TODAY, "08:00"), ends_at: at(TODAY, "09:00"), site: "1 Site Rd" }];
    const [p] = recommend(input({ loads: [load("A")], trucks, bookings }));
    expect(p.proposal?.truckLabel).toBe("103");
    expect(p.proposal?.reasons[0]).toMatch(/Already working this job that day/);
    const [q] = recommend(input({ loads: [load("A")], trucks }));
    expect(q.proposal?.truckLabel).toBe("102"); // 20 of 22 t beats 20 of 40 t
    expect(q.alternatives.length).toBeGreaterThan(0);
  });

  it("4. a truck out of service (maintenance) is excluded, with its expected return", () => {
    const [p] = recommend(input({ loads: [load("A")], trucks: [truck("101", { service_status: "out_of_service", expected_return_date: "2026-10-14" })] }));
    expect(p.proposal).toBeNull();
    expect(p.excludedTrucks[0].reasons[0]).toBe("Out of service (expected back 2026-10-14).");
    expect(p.blocked?.options.join(" ")).toMatch(/expected back in service on 2026-10-14 — after this load's date/);
  });

  it("5. an unresolved breakdown or inspection report blocks the truck; an equipment issue only warns", () => {
    const trucks = [truck("101"), truck("102")];
    const [p] = recommend(input({ loads: [load("A")], trucks, truckReports: [{ truck_id: "t-101", kind: "breakdown" }, { truck_id: "t-102", kind: "equipment_issue" }] }));
    expect(p.excludedTrucks.map((e) => e.label)).toEqual(["101"]);
    expect(p.excludedTrucks[0].reasons[0]).toMatch(/breakdown or inspection problem/);
    expect(p.proposal?.truckLabel).toBe("102");
    expect(p.proposal?.warnings.join(" ")).toMatch(/equipment issue/);
  });

  it("6. insufficient capacity and tractors are excluded; unknown capacity is a warning, not a pass", () => {
    const trucks = [truck("SMALL", { weight_capacity: 15 }), truck("TRAC", { truck_type: "tractor" }), truck("UNK", { weight_capacity: null })];
    const [p] = recommend(input({ loads: [load("A")], trucks }));
    expect(Object.fromEntries(p.excludedTrucks.map((e) => [e.label, e.reasons[0]]))).toEqual({
      SMALL: "Planned 20 ton exceeds its recorded capacity of 15 ton.",
      TRAC: "A tractor needs a trailer; Smart Dispatch does not choose trailers — assign it on the board.",
    });
    expect(p.proposal?.truckLabel).toBe("UNK");
    expect(p.proposal?.warnings[0]).toMatch(/Capacity in ton is not recorded/);
  });

  it("7. an unavailable or unqualified driver is excluded with the reason", () => {
    const drivers = [
      qualified({ id: "d-exp", name: "Expired", qualifications: [{ kind: "cdl", cdl_class: "A", expires_on: "2026-01-01", verified_at: "2025-01-01T00:00:00Z" }, { kind: "medical_card", cdl_class: null, expires_on: "2027-01-01", verified_at: "2025-01-01T00:00:00Z" }] }),
      qualified({ id: "d-unv", name: "Unverified", qualifications: [{ kind: "cdl", cdl_class: "A", expires_on: "2028-01-01", verified_at: null }, { kind: "medical_card", cdl_class: null, expires_on: "2027-01-01", verified_at: "2025-01-01T00:00:00Z" }] }),
      qualified({ id: "d-off", name: "Inactive", active: false }),
    ];
    const [p] = recommend(input({ loads: [load("A")], drivers }));
    expect(p.proposal).toBeNull();
    expect(Object.fromEntries(p.excludedDrivers.map((e) => [e.label, e.reasons[0]]))).toEqual({
      Expired: "Driver's CDL has expired.",
      Inactive: "Driver is inactive.",
      Unverified: "Driver's CDL has not been verified.",
    });
    expect(p.blocked?.options).toContain("Unverified would be eligible once the qualification is verified in Fleet → Drivers.");
  });

  it("8. an existing booking at an overlapping time excludes the truck and driver", () => {
    const bookings = [{ load_id: "X", order_id: "o-X", truck_id: "t-101", driver_id: "d-avery", load_date: TODAY, starts_at: at(TODAY, "13:30"), ends_at: at(TODAY, "15:00"), site: "elsewhere" }];
    const [p] = recommend(input({ loads: [load("A")], bookings }));
    expect(p.proposal).toBeNull();
    expect(p.excludedTrucks[0].reasons).toEqual(["Already booked at an overlapping time."]);
    expect(p.excludedDrivers[0].reasons).toEqual(["Already booked at an overlapping time."]);
  });

  it("9. no feasible assignment: explains why and offers alternatives that need a dispatcher's decision", () => {
    const bookings = [{ load_id: "X", order_id: "o-X", truck_id: "t-101", driver_id: "d-avery", load_date: TODAY, starts_at: at(TODAY, "12:00"), ends_at: at(TODAY, "16:00"), site: "x" }];
    const [p] = recommend(input({ loads: [load("A", { requested_date: TODAY })], bookings }));
    expect(p.proposal).toBeNull();
    expect(p.blocked?.why).toEqual(["None of the 1 trucks can take this load (see the reasons below).", "None of the 1 drivers can take this load (see the reasons below)."]);
    expect(p.blocked?.options.join(" ")).toMatch(/available on 2026-10-13 at the same time — later than the customer's requested date \(2026-10-12\); confirm with the customer first/);
  });

  it("10/14. rejected pairs are not proposed again; reconsidering brings them back (approval itself is re-checked in the database)", () => {
    const drivers = [qualified({ id: "d-a", name: "Avery" }), qualified({ id: "d-b", name: "Blake" })];
    const first = recommend(input({ loads: [load("A")], drivers }))[0].proposal!;
    const after = recommend(input({ loads: [load("A")], drivers, rejections: [{ load_id: "A", truck_id: first.truckId, driver_id: first.driverId }] }))[0];
    expect(after.proposal).not.toMatchObject({ truckId: first.truckId, driverId: first.driverId });
    expect(after.rejectedPairs).toBe(1);
    const all = recommend(input({ loads: [load("A")], drivers: [drivers[0]], rejections: [{ load_id: "A", truck_id: "t-101", driver_id: "d-a" }] }))[0];
    expect(all.proposal).toBeNull();
    expect(all.blocked?.why).toEqual(["Every remaining truck-and-driver pair was rejected by a dispatcher. Reconsider them, or assign manually."]);
  });

  it("12. incomplete data is never treated as OK: no trucks, no qualifications, unknown capacity", () => {
    expect(recommend(input({ loads: [load("A")], trucks: [] }))[0].blocked?.why[0]).toBe("No active trucks are recorded.");
    const [p] = recommend(input({ loads: [load("A")], drivers: [qualified({ id: "d-none", name: "New hire", qualifications: [] })] }));
    expect(p.excludedDrivers[0].reasons).toEqual(["No CDL is recorded for this driver.", "No DOT medical card is recorded for this driver."]);
  });

  it("13. several days: near-term first, resources reused across days, workload spread, deterministic", () => {
    const d2 = "2026-10-13";
    const loads = [load("L3", { load_date: d2, starts_at: at(d2, "08:00"), ends_at: at(d2, "09:00"), order_number: "O-3" }), load("L1", { order_number: "O-1" }), load("L2", { order_number: "O-2", starts_at: at(TODAY, "13:30"), ends_at: at(TODAY, "14:30") })];
    const drivers = [qualified({ id: "d-a", name: "Avery" }), qualified({ id: "d-b", name: "Blake" })];
    const trucks = [truck("101"), truck("102")];
    const a = recommend(input({ loads, drivers, trucks }));
    expect(a.map((p) => p.load.id)).toEqual(["L1", "L2", "L3"]);
    expect(a[0].proposal?.truckLabel).not.toBe(a[1].proposal?.truckLabel); // overlapping loads get different trucks
    expect(a[0].proposal?.driverLabel).not.toBe(a[1].proposal?.driverLabel);
    expect(a[2].proposal).not.toBeNull(); // the next day is free again
    expect(JSON.stringify(recommend(input({ loads: [...loads].reverse(), drivers: [...drivers].reverse(), trucks: [...trucks].reverse() })))).toBe(JSON.stringify(a));
  });
});

describe("Smart Dispatch and maintenance / hours of service", () => {
  it("excludes a truck in the shop on the load date or under a safety restriction, and warns about open shop work", () => {
    const trucks = [truck("101"), truck("102"), truck("103")];
    const shopVisits = [
      { truck_id: "t-101", number: "WO-1", status: "scheduled", scheduled_for: TODAY, safety_critical: false },
      { truck_id: "t-102", number: "WO-2", status: "in_progress", scheduled_for: null, safety_critical: true },
      { truck_id: "t-103", number: "WO-3", status: "awaiting_parts", scheduled_for: null, safety_critical: false },
    ];
    const [p] = recommend(input({ loads: [load("A")], trucks, shopVisits }));
    const why = Object.fromEntries(p.excludedTrucks.map((x) => [x.label, x.reasons.join(" ")]));
    expect(why["101"]).toMatch(/In the shop on this date \(WO-1\)/);
    expect(why["102"]).toMatch(/Safety-critical work order WO-2/);
    expect(p.proposal?.truckLabel).toBe("103");
    expect(p.proposal!.warnings.join(" ")).toMatch(/Shop work WO-3 is awaiting parts/);
  });

  it("a shop visit on another day does not block, and when nothing is safe it says so", () => {
    const visitTomorrow = [{ truck_id: "t-101", number: "WO-9", status: "scheduled", scheduled_for: "2026-10-13", safety_critical: false }];
    expect(recommend(input({ loads: [load("A")], shopVisits: visitTomorrow }))[0].proposal?.truckLabel).toBe("101");
    const restricted = [{ truck_id: "t-101", number: "WO-8", status: "reported", scheduled_for: null, safety_critical: true }];
    const [p] = recommend(input({ loads: [load("A")], shopVisits: restricted }));
    expect(p.proposal).toBeNull();
    expect(p.blocked!.why.join(" ")).toMatch(/None of the 1 trucks can take this load/);
  });

  it("never claims hours-of-service compliance, and says when maintenance could not be checked", () => {
    const [p] = recommend(input({ loads: [load("A")], maintenanceChecked: false }));
    expect(p.notes.join(" ")).toMatch(/Hours of service are not checked/);
    expect(p.notes.join(" ")).toMatch(/Maintenance shop dates were not checked/);
  });
});

describe("Smart Dispatch and time off", () => {
  const leave = (status: "approved" | "pending", from: string, to: string) => ({ driver_id: "d-avery", status, starts_at: at(TODAY, from), ends_at: at(TODAY, to) });
  it("excludes a driver whose approved leave overlaps the load, but not one whose leave is at another time", () => {
    const blocked = recommend(input({ loads: [load("A")], timeOff: [leave("approved", "12:00", "16:00")] }))[0];
    expect(blocked.proposal).toBeNull();
    expect(blocked.excludedDrivers[0].reasons.join(" ")).toMatch(/Approved time off covers this load/);
    const free = recommend(input({ loads: [load("A")], timeOff: [leave("approved", "06:00", "10:00")] }))[0];
    expect(free.proposal?.driverLabel).toBe("Avery");
  });
  it("pending leave only warns, and missing time-off data is disclosed", () => {
    const [p] = recommend(input({ loads: [load("A")], timeOff: [leave("pending", "00:00", "23:59")], timeOffChecked: true }));
    expect(p.proposal!.warnings.join(" ")).toMatch(/pending time-off request/);
    expect(recommend(input({ loads: [load("A")], timeOffChecked: false }))[0].notes.join(" ")).toMatch(/Driver time off was not checked/);
  });
  it("a driver whose employee record says On leave is still proposed, with a warning (no invented block)", () => {
    const [p] = recommend(input({ loads: [load("A")], driversOnLeave: ["d-avery"] }));
    expect(p.proposal?.driverLabel).toBe("Avery");
    expect(p.proposal!.warnings.join(" ")).toMatch(/employee record says On leave/);
  });

  // Expired vehicle documents (20261112000200, owner 2026-10-13): a verified expired document on a "block" kind
  // excludes the truck, as the database refuses it; an unverified one, or a "warn" kind, is a warning only.
  it("a verified expired insurance blocks the truck; an unverified one or an expired inspection only warns", () => {
    const issue = (over: Record<string, unknown>) => ({ truck_id: "t-101", trailer_id: null, kind: "insurance", expires_on: "2026-09-30", verified: true, action: "block" as const, blocks: true, ...over });
    const blocked = recommend(input({ loads: [load("A")], trucks: [truck("101"), truck("102")], documentIssues: [issue({})] }))[0];
    expect(blocked.proposal?.truckLabel).toBe("102");
    expect(blocked.excludedTrucks.find((t) => t.label === "101")?.reasons.join(" ")).toMatch(/insurance expired 2026-09-30 \(verified\) — the company rule blocks it/);

    const unverified = recommend(input({ loads: [load("A")], documentIssues: [issue({ verified: false, blocks: false })] }))[0];
    expect(unverified.proposal?.truckLabel).toBe("101");
    expect(unverified.proposal!.warnings.join(" ")).toMatch(/insurance expired 2026-09-30 on record \(not verified\) — confirm it was renewed/);

    const inspection = recommend(input({ loads: [load("A")], documentIssues: [issue({ kind: "inspection", action: "warn", blocks: false })] }))[0];
    expect(inspection.proposal?.truckLabel).toBe("101");
    // A document that expires after the load date changes nothing.
    const later = recommend(input({ loads: [load("A")], documentIssues: [issue({ expires_on: "2026-12-31" })] }))[0];
    expect(later.proposal?.truckLabel).toBe("101");
  });

  it("tractor fleets: with the trailer rules each tractor is proposed with a free trailer; two overlapping loads get two trailers", () => {
    const trailer = (unit: string, extra: Partial<OptTrailer> = {}): OptTrailer => ({
      id: "tr-" + unit, unit_number: unit, active: true, service_status: "in_service", weight_capacity: 22, weight_unit: "ton", volume_capacity: null, capacity_verified_at: null, compatible_truck_types: ["tractor"], ...extra,
    });
    const base = input({
      trucks: [truck("201", { truck_type: "tractor" }), truck("202", { truck_type: "tractor" })],
      drivers: [qualified({ id: "d-a", name: "A" }), qualified({ id: "d-b", name: "B" })],
      loads: [load("X"), load("Y", { order_number: "O-Y" })],
    });
    const full: OptimizationInput = { ...base, revenueCents: {}, trailers: [trailer("T-51"), trailer("T-52", { service_status: "out_of_service" }), trailer("T-53")] };
    const plans = recommend({ ...base, pickTrailer: (t, l, d, busy) => pickTrailer(full, l, t, d, busy) });
    expect(plans.every((p) => p.proposal)).toBe(true);
    const used = plans.map((p) => p.proposal!.trailerId);
    expect(new Set(used).size).toBe(2); // never the same trailer twice at the same time
    expect(used).not.toContain("tr-T-52"); // out of service
    expect(plans[0].proposal!.truckLabel).toMatch(/^20[12] \+ T-5[13]$/);
    // No usable trailer: the tractor is excluded with the reason.
    const none = recommend({ ...base, loads: [load("Z")], pickTrailer: () => null });
    expect(none[0].proposal).toBeNull();
    expect(none[0].excludedTrucks[0].reasons.join(" ")).toMatch(/No usable trailer is free/);
  });
});
