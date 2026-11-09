import { describe, expect, it } from "vitest";
import { notReadyText, shopHolds, vehicleReadyOn, type ReadinessWorkOrder } from "@/lib/fleet/readiness";

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
