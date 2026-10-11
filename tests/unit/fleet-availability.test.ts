import { describe, expect, it } from "vitest";
import { documentAttention, documentState, downtimeDays, maskVin, vehicleAvailability, type OpenWorkOrder } from "@/lib/fleet/availability";

const truck = { active: true, service_status: "in_service" as const, out_of_service_reason: "", expected_return_date: null };
const wo = (p: Partial<OpenWorkOrder>): OpenWorkOrder => ({ id: "w", number: "WO-2026-0001", title: "Job", status: "reported", safety_critical: false, scheduled_for: null, clearance_status: null, ...p });
const today = "2026-10-11";

describe("vehicle availability", () => {
  it("is available with no restriction, and lists future shop dates without blocking", () => {
    const a = vehicleAvailability(truck, [wo({ status: "scheduled", scheduled_for: "2026-10-14" })], today);
    expect(a).toMatchObject({ state: "available", ready: true });
    expect(a.upcoming).toEqual([{ date: "2026-10-14", number: "WO-2026-0001", title: "Job" }]);
    expect(a.detail).toMatch(/2026-10-14/);
  });

  it("never presents a safety-restricted truck as ready, even if its status says in service", () => {
    const a = vehicleAvailability(truck, [wo({ safety_critical: true, status: "in_progress" })], today);
    expect(a).toMatchObject({ state: "restricted", ready: false });
    const b = vehicleAvailability({ ...truck, service_status: "out_of_service" }, [wo({ safety_critical: true, status: "awaiting_inspection" })], today);
    expect(b).toMatchObject({ state: "awaiting_clearance", ready: false });
  });

  it("separates ordinary out of service, open shop work and inactive", () => {
    expect(vehicleAvailability({ ...truck, service_status: "out_of_service", out_of_service_reason: "Tires", expected_return_date: "2026-10-20" }, [], today))
      .toMatchObject({ state: "out_of_service", ready: false, detail: "Tires Expected back 2026-10-20." });
    expect(vehicleAvailability(truck, [wo({ status: "awaiting_parts" })], today)).toMatchObject({ state: "in_shop", ready: true });
    expect(vehicleAvailability({ ...truck, active: false }, [], today)).toMatchObject({ state: "inactive", ready: false });
  });
});

describe("documents", () => {
  it("flags expired and expiring (30 days) and names registration/insurance when not recorded", () => {
    expect(documentState(null, today)).toBe("no_expiry");
    expect(documentState("2026-10-10", today)).toBe("expired");
    expect(documentState("2026-11-10", today)).toBe("expiring");
    expect(documentState("2026-11-11", today)).toBe("valid");
    const att = documentAttention([{ kind: "registration" as const, expires_on: "2026-10-01" }, { kind: "permit" as const, expires_on: "2026-10-20" }], today);
    expect(att.expired.map((d) => d.kind)).toEqual(["registration"]);
    expect(att.expiring.map((d) => d.kind)).toEqual(["permit"]);
    expect(att.notRecorded).toEqual(["insurance"]);
  });
});

describe("downtime", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  it("counts recorded out-of-service time inside the period only", () => {
    const events = [
      { from_status: "in_service", to_status: "out_of_service", occurred_at: "2026-06-01T12:00:00Z" }, // before the period
      { from_status: "out_of_service", to_status: "in_service", occurred_at: "2026-07-15T12:00:00Z" }, // 2 days inside (period starts Jul 13)
      { from_status: "in_service", to_status: "out_of_service", occurred_at: "2026-10-01T12:00:00Z" },
      { from_status: "out_of_service", to_status: "in_service", occurred_at: "2026-10-04T12:00:00Z" },
    ];
    expect(downtimeDays(events, { service_status: "in_service", out_of_service_since: null }, now, 90)).toBe(5);
  });
  it("includes the current open period", () => {
    expect(downtimeDays([], { service_status: "out_of_service", out_of_service_since: "2026-10-09T12:00:00Z" }, now, 90)).toBe(2);
  });
});

it("masks VINs to the last 6 characters", () => {
  expect(maskVin("1HGCM82633A004352")).toBe("…004352");
  expect(maskVin("")).toBe("");
});
