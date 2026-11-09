import { describe, expect, it } from "vitest";
import { driverNotReadyText, driverReadyCaption, driverReadyOn, notReadyText, shopHolds, summarizeDriversReady, vehicleReadyOn, type ReadinessDriver, type ReadinessTimeOff, type ReadinessWorkOrder } from "@/lib/fleet/readiness";

// The shared truck and trailer readiness rule (owner decision 2026-11-09, master plan WK1), used by Taviron Live, the
// dispatch board, Fleet, Maintenance, Smart Dispatch and Plan the day.
const today = "2026-11-09";
const later = "2026-11-12";
const inService = { active: true, service_status: "in_service", expected_return_date: null };
const wo = (p: Partial<ReadinessWorkOrder>): ReadinessWorkOrder => ({ number: "WO-1", status: "reported", scheduled_for: null, safety_critical: false, ...p });

describe("truck and trailer readiness", () => {
  it("is ready with no shop work and in service", () => {
    expect(vehicleReadyOn(inService, [], today, today)).toEqual({ ready: true, reason: null, workOrder: null, expectedBack: null });
  });

  it("an open safety-critical work order makes it not ready on every day, even while waiting for inspection", () => {
    for (const status of ["reported", "in_progress", "awaiting_inspection"]) {
      expect(vehicleReadyOn(inService, [wo({ status, safety_critical: true })], later, today)).toMatchObject({ ready: false, reason: "safety_restricted" });
    }
    expect(vehicleReadyOn(inService, [wo({ status: "completed", safety_critical: true })], today, today).ready).toBe(true);
  });

  it("a work order scheduled for the day makes it not ready that day only, unless it is waiting for inspection", () => {
    for (const status of ["reported", "triaged", "scheduled", "in_progress", "awaiting_parts"]) {
      expect(vehicleReadyOn(inService, [wo({ status, scheduled_for: today })], today, today)).toMatchObject({ ready: false, reason: "shop_scheduled" });
    }
    expect(vehicleReadyOn(inService, [wo({ status: "scheduled", scheduled_for: today })], later, today).ready).toBe(true);
    expect(vehicleReadyOn(inService, [wo({ status: "awaiting_inspection", scheduled_for: today })], today, today).ready).toBe(true);
  });

  it("shop work in progress or waiting for parts makes it not ready on any day, with its work order", () => {
    for (const status of ["in_progress", "awaiting_parts"]) {
      const r = vehicleReadyOn(inService, [wo({ status, number: "WO-7" })], later, today);
      expect(r).toMatchObject({ ready: false, reason: "in_shop", workOrder: { number: "WO-7" } });
      expect(notReadyText("truck", r)).toBe("Truck is in the shop (WO-7): work is in progress or waiting for parts. It cannot be assigned until the work is done.");
    }
  });

  it("out of service is not ready today whatever the expected return date; on a later day it counts from that date", () => {
    const down = { active: true, service_status: "out_of_service", expected_return_date: "2026-11-10" };
    expect(vehicleReadyOn({ ...down, expected_return_date: today }, [], today, today)).toMatchObject({ ready: false, reason: "out_of_service" });
    expect(vehicleReadyOn({ ...down, expected_return_date: "2026-11-01" }, [], today, today)).toMatchObject({ ready: false, reason: "out_of_service" });
    expect(vehicleReadyOn(down, [], "2026-11-10", today)).toEqual({ ready: true, reason: null, workOrder: null, expectedBack: "2026-11-10" });
    expect(vehicleReadyOn(down, [], later, today).ready).toBe(true);
    expect(vehicleReadyOn({ ...down, expected_return_date: null }, [], later, today)).toMatchObject({ ready: false, reason: "out_of_service" });
    // Back by then, but still in the shop: not ready.
    expect(vehicleReadyOn(down, [wo({ status: "awaiting_parts" })], later, today)).toMatchObject({ ready: false, reason: "in_shop" });
    expect(vehicleReadyOn({ ...inService, active: false }, [], today, today)).toMatchObject({ ready: false, reason: "inactive" });
  });

  it("lists holds as the database does: safety first, then a visit that day or else work in progress", () => {
    const holds = shopHolds([wo({ number: "A", safety_critical: true }), wo({ number: "B", status: "in_progress" }), wo({ number: "C", status: "scheduled", scheduled_for: today })], today);
    expect(holds.map((h) => [h.reason, h.workOrder.number])).toEqual([["safety_restricted", "A"], ["shop_scheduled", "C"]]);
    expect(shopHolds([wo({ status: "in_progress" })], today).map((h) => h.reason)).toEqual(["in_shop"]);
    expect(shopHolds([wo({ status: "canceled", scheduled_for: today })], today)).toEqual([]);
  });
});

// The shared driver rule (owner decision 2026-11-09, master plan WK1): active, valid verified CDL and medical card,
// not on approved full-day time off; hired-truck drivers counted apart.
describe("driver readiness", () => {
  const verified = "2026-01-01T00:00:00Z";
  const cdl = { kind: "cdl" as const, cdl_class: "A" as const, expires_on: "2027-05-01", verified_at: verified };
  const med = { kind: "medical_card" as const, cdl_class: null, expires_on: "2027-01-01", verified_at: verified };
  const drv = (p: Partial<ReadinessDriver> = {}): ReadinessDriver => ({ id: "d1", active: true, qualifications: [cdl, med], ...p });
  const off = (p: Partial<ReadinessTimeOff> = {}): ReadinessTimeOff => ({ driver_id: "d1", status: "approved", start_date: today, end_date: today, full_day: true, ...p });

  it("is ready when active with a valid verified CDL and medical card and no time off", () => {
    expect(driverReadyOn(drv(), [], today)).toEqual({ ready: true, reason: null, blockers: [], documents: [], partialTimeOff: false, pendingTimeOff: false, hired: false });
  });

  it("is not qualified without a medical card, with an expired CDL or an unverified document, and names the document", () => {
    const noCard = driverReadyOn(drv({ qualifications: [cdl] }), [], today);
    expect([noCard.ready, noCard.reason, noCard.blockers, noCard.documents]).toEqual([false, "not_qualified", ["medical_card_missing"], ["medical_card"]]);
    const expired = driverReadyOn(drv({ qualifications: [{ ...cdl, expires_on: "2026-11-08" }, med] }), [], today);
    expect([expired.reason, expired.blockers, expired.documents]).toEqual(["not_qualified", ["cdl_expired"], ["cdl"]]);
    const unverified = driverReadyOn(drv({ qualifications: [{ ...cdl, verified_at: null }, { ...med, verified_at: null }] }), [], today);
    expect([unverified.blockers, unverified.documents]).toEqual([["cdl_unverified", "medical_card_unverified"], ["cdl", "medical_card"]]);
    expect(driverNotReadyText(unverified)).toBe("Not qualified: CDL and medical card not valid and verified on this date.");
    // Valid on its last day, expired the day after.
    expect(driverReadyOn(drv({ qualifications: [cdl, { ...med, expires_on: today }] }), [], today).ready).toBe(true);
    expect(driverReadyOn(drv({ qualifications: [cdl, { ...med, expires_on: today }] }), [], later).reason).toBe("not_qualified");
  });

  it("is not ready on approved full-day time off; partial days and pending requests stay ready and are flagged", () => {
    expect(driverReadyOn(drv(), [off()], today).reason).toBe("time_off");
    expect(driverReadyOn(drv(), [off({ start_date: "2026-11-08", end_date: "2026-11-10" })], today).ready).toBe(false);
    expect(driverReadyOn(drv(), [off({ end_date: "2026-11-08", start_date: "2026-11-08" })], today).ready).toBe(true);
    const partial = driverReadyOn(drv(), [off({ full_day: false })], today);
    expect([partial.ready, partial.partialTimeOff]).toEqual([true, true]);
    const pending = driverReadyOn(drv(), [off({ status: "pending" })], today);
    expect([pending.ready, pending.pendingTimeOff]).toEqual([true, true]);
    // Another driver's leave does not count.
    expect(driverReadyOn(drv(), [off({ driver_id: "d2" })], today).ready).toBe(true);
    expect(driverNotReadyText({ reason: "time_off", documents: [] })).toBe("On approved full-day time off.");
  });

  it("an inactive driver is never ready", () => {
    expect(driverReadyOn(drv({ active: false }), [], today).reason).toBe("inactive");
  });

  it("counts the company's own drivers and hired-truck drivers apart", () => {
    const s = summarizeDriversReady([
      drv({ id: "a" }),
      drv({ id: "b", qualifications: [cdl] }),
      drv({ id: "c" }),
      drv({ id: "d", active: false }),
      drv({ id: "h1", hired: true }),
      drv({ id: "h2", hired: true, qualifications: [] }),
    ], [off({ driver_id: "c" }), off({ driver_id: "a", full_day: false })], today);
    expect(s).toEqual({ total: 3, ready: 1, notQualified: 1, off: 1, partial: 1, pending: 0, hired: { total: 2, ready: 1 } });
    expect(driverReadyCaption(s)).toBe("1 not qualified, 1 on time off");
    expect(driverReadyCaption({ ...s, notQualified: 0, off: 0 }, false)).toBe("Verified CDL and medical card, not off; time off not checked");
  });
});
