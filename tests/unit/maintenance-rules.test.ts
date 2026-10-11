import { describe, expect, it } from "vitest";
import { costSchema, nextStatuses, rankWorkOrders, readingSchema, scheduleSchema, workOrderSchema, type PriorityInput } from "@/lib/maintenance";

const base: PriorityInput = {
  id: "x", status: "reported", urgency: "normal", safety_critical: false, due_on: null, scheduled_for: null,
  created_at: "2026-10-01T10:00:00Z", truck_out_of_service: false, truck_has_driver: false,
};

describe("shop priority (rules, not AI)", () => {
  it("puts safety first, explains every reason, and leaves finished work out", () => {
    const ranked = rankWorkOrders([
      { ...base, id: "low", urgency: "low" },
      { ...base, id: "safety", safety_critical: true, truck_out_of_service: true },
      { ...base, id: "late", urgency: "high", due_on: "2026-10-05" },
      { ...base, id: "parts", urgency: "high", status: "awaiting_parts" },
      { ...base, id: "done", urgency: "immediate", status: "completed" },
    ], "2026-10-10");
    expect(ranked.map((r) => r.item.id)).toEqual(["safety", "late", "parts", "low"]);
    expect(ranked[0].reasons[0]).toMatch(/Safety-critical/);
    expect(ranked[0].reasons).toContain("Truck is out of service (downtime)");
    expect(ranked[1].reasons).toContain("Past its due date (2026-10-05)");
    expect(ranked[2].reasons).toContain("Blocked: waiting for parts");
  });

  it("breaks ties by age (oldest first)", () => {
    const r = rankWorkOrders([{ ...base, id: "new", created_at: "2026-10-09T00:00:00Z" }, { ...base, id: "old" }], "2026-10-10");
    expect(r.map((x) => x.item.id)).toEqual(["old", "new"]);
  });
});

describe("lifecycle buttons", () => {
  it("never offers to complete a safety-critical repair directly", () => {
    expect(nextStatuses("in_progress", false)).toContain("completed");
    expect(nextStatuses("in_progress", true)).not.toContain("completed");
    expect(nextStatuses("in_progress", true)).toContain("awaiting_inspection");
    expect(nextStatuses("awaiting_inspection", false)).toEqual([]);
    expect(nextStatuses("closed", false)).toEqual([]);
  });
});

describe("validation", () => {
  const uuid = "00000000-0000-4000-8000-000000000001";
  it("requires a truck and a title; empty optional fields become null", () => {
    expect(workOrderSchema.safeParse({ truck_id: "", title: "Fix", category: "repair", urgency: "normal" }).success).toBe(false);
    const ok = workOrderSchema.parse({ truck_id: uuid, title: "Air leak", category: "brakes", urgency: "high", driver_id: "", scheduled_for: "" });
    expect(ok).toMatchObject({ driver_id: null, scheduled_for: null, safety_critical: false });
    expect(workOrderSchema.parse({ truck_id: uuid, title: "Air leak", category: "brakes", urgency: "high", safety_critical: "on" }).safety_critical).toBe(true);
  });

  it("needs at least one PM interval and whole days", () => {
    expect(scheduleSchema.safeParse({ truck_id: uuid, name: "Oil" }).success).toBe(false);
    expect(scheduleSchema.safeParse({ truck_id: uuid, name: "Oil", interval_days: "10.5" }).success).toBe(false);
    expect(scheduleSchema.parse({ truck_id: uuid, name: "Oil", interval_miles: "15,000" }).interval_miles).toBe(15000);
  });

  it("needs a reading value and a well-formed cost", () => {
    expect(readingSchema.safeParse({ truck_id: uuid }).success).toBe(false);
    expect(readingSchema.parse({ truck_id: uuid, engine_hours: "1200.5" }).engine_hours).toBe(1200.5);
    expect(costSchema.parse({ kind: "part", description: "Filter", quantity: "2", unit_cost: "$41.50" })).toMatchObject({ quantity: 2, unit_cost: 4150 });
    expect(costSchema.safeParse({ kind: "part", description: "Filter", quantity: "0", unit_cost: "1" }).success).toBe(false);
  });
});
