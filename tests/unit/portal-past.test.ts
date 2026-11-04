import { describe, expect, it } from "vitest";
import { portalIsPast, portalStatusLabel } from "@/lib/portal";

// UX5: an order whose days are over, with nothing more planned and every delivery confirmed, reads "Delivered" in the
// customer portal and sits with past orders, even before the office closes it.
const base = { status: "scheduled", status_label: "Scheduled", scheduled_start: "2026-10-23", scheduled_end: "2026-10-30", next_load: null, tickets_confirmed: 2, tickets_reported: 0 };

describe("portal order grouping", () => {
  it("moves finished orders to the past", () => {
    expect(portalIsPast(base, "2026-11-04")).toBe(true);
    expect(portalStatusLabel(base, "2026-11-04")).toBe("Delivered");
  });
  it("keeps orders open while days, loads or checks remain", () => {
    expect(portalIsPast(base, "2026-10-30")).toBe(false);
    expect(portalIsPast({ ...base, next_load: { date: "2026-11-05", start: null, end: null } }, "2026-11-04")).toBe(false);
    expect(portalIsPast({ ...base, tickets_reported: 1 }, "2026-11-04")).toBe(false);
    expect(portalIsPast({ ...base, tickets_confirmed: 0 }, "2026-11-04")).toBe(false);
    expect(portalIsPast({ ...base, status: "on_hold" }, "2026-11-04")).toBe(false);
  });
  it("completed and canceled are past and keep their own label", () => {
    expect(portalIsPast({ ...base, status: "canceled" }, "2026-10-01")).toBe(true);
    expect(portalStatusLabel({ ...base, status: "completed", status_label: "Completed" }, "2026-11-04")).toBe("Completed");
  });
});
