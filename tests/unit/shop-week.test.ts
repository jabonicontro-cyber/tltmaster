import { describe, expect, it } from "vitest";
import { hoursText, outOfServiceMs, shopWeek, weekOf } from "@/lib/maintenance/shop-week";

// The weekly shop report (2026-11-09): derived from existing records only.
const DAY = 86400_000;
const at = (iso: string) => Date.parse(iso);

describe("weekly shop report", () => {
  it("runs Monday to Monday", () => {
    expect(weekOf("2026-11-09")).toEqual({ start: "2026-11-09", end: "2026-11-16" });
    expect(weekOf("2026-11-15")).toEqual({ start: "2026-11-09", end: "2026-11-16" });
    expect(weekOf("2026-11-16")).toEqual({ start: "2026-11-16", end: "2026-11-23" });
  });

  it("counts out-of-service time inside the week only, never after now", () => {
    const start = at("2026-11-09T00:00:00Z"), end = at("2026-11-16T00:00:00Z");
    const inService = { service_status: "in_service", out_of_service_since: null };
    // Out from the week before until Wednesday noon: 2.5 days.
    expect(outOfServiceMs([{ from_status: "in_service", to_status: "out_of_service", occurred_at: "2026-11-05T00:00:00Z" }, { from_status: "out_of_service", to_status: "in_service", occurred_at: "2026-11-11T12:00:00Z" }], inService, start, end, end + DAY) / DAY).toBe(2.5);
    // Still out, and now is Friday: Thursday to Friday counts, the weekend not yet.
    expect(outOfServiceMs([{ from_status: "in_service", to_status: "out_of_service", occurred_at: "2026-11-12T00:00:00Z" }], { service_status: "out_of_service", out_of_service_since: "2026-11-12T00:00:00Z" }, start, end, at("2026-11-13T00:00:00Z")) / DAY).toBe(1);
    // No history: the current status from when it was recorded.
    expect(outOfServiceMs([], { service_status: "out_of_service", out_of_service_since: "2026-11-14T00:00:00Z" }, start, end, end + DAY) / DAY).toBe(2);
    expect(outOfServiceMs([], inService, start, end, end) ).toBe(0);
  });

  it("adds up the week from the records and says what is not recorded", () => {
    const wo = (id: string, p: Partial<{ created_at: string; completed_at: string | null; closed_at: string | null; schedule_id: string | null; category: string }>) =>
      ({ id, number: `WO-${id}`, title: id, truck_id: "t1", trailer_id: null, category: "repair", schedule_id: null, created_at: "2026-11-01T10:00:00Z", completed_at: null, closed_at: null, ...p });
    const r = shopWeek({
      start: "2026-11-09", end: "2026-11-16", startMs: at("2026-11-09T00:00:00Z"), endMs: at("2026-11-16T00:00:00Z"), nowMs: at("2026-11-20T00:00:00Z"),
      workOrders: [wo("a", { created_at: "2026-11-10T08:00:00Z" }), wo("b", { completed_at: "2026-11-11T08:00:00Z", schedule_id: "s1" }), wo("c", { closed_at: "2026-11-12T08:00:00Z" })],
      time: [{ work_order_id: "a", started_at: "2026-11-10T08:00:00Z", ended_at: "2026-11-10T09:30:00Z" }, { work_order_id: "a", started_at: "2026-11-15T08:00:00Z", ended_at: null }],
      partCosts: [{ work_order_id: "a", quantity: 3, unit_cost_cents: 1895 }, { work_order_id: "a", quantity: -1, unit_cost_cents: 1895 }],
      trucks: [{ id: "t1", unit_number: "12", service_status: "in_service", out_of_service_since: null }, { id: "t2", unit_number: "7", service_status: "in_service", out_of_service_since: null }],
      events: [{ truck_id: "t1", from_status: "in_service", to_status: "out_of_service", occurred_at: "2026-11-10T00:00:00Z" }, { truck_id: "t1", from_status: "out_of_service", to_status: "in_service", occurred_at: "2026-11-11T00:00:00Z" }],
      pm: [{ schedule_id: "s2", truck_id: "t1", unit_number: "12", name: "Oil", state: "due_soon", next_due_on: "2026-11-14", open_work_order_number: null },
        { schedule_id: "s3", truck_id: "t1", unit_number: "12", name: "Grease", state: "ok", next_due_on: "2026-12-01", open_work_order_number: null }],
    });
    expect([r.opened, r.completed, r.closed].map((x) => x.map((w) => w.id))).toEqual([["a"], ["b"], ["c"]]);
    expect([r.laborMinutes, r.runningTimers, r.partsCents]).toEqual([90, 1, 3790]);
    expect(r.outOfService).toEqual([{ truck_id: "t1", unit_number: "12", days: 1 }]);
    expect([r.pmDone.map((w) => w.id), r.pmDue.map((p) => p.schedule_id)]).toEqual([["b"], ["s2"]]);
    expect(hoursText(90)).toBe("1 h 30 min");
  });
});
