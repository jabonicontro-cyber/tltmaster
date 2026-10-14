import { describe, expect, it } from "vitest";
import { lifecycle, summarize, waitingDays, type OrderRow } from "@/lib/order-to-cash";

// Order-to-Cash Control Center (B42 increment 1): every order lands on one stage, with why, who acts next and where,
// using only what billing_order_status computes. Fictional rows.

const row = (over: Partial<OrderRow> = {}): OrderRow => ({
  order_id: "o1", order_number: "O-1", status: "scheduled", customer_name: "Customer (test)", project_name: null,
  scheduled_start: "2026-10-10", order_date: "2026-10-01", completed_at: null, total_cents: 100_00,
  loads_total: 2, loads_missing: 0, loads_not_due: 1, tickets_live: 1, tickets_pending: 0, exceptions_count: 0,
  readiness: "in_progress", fulfilled: false, fulfillment_gap: "loads_upcoming", handed_off_at: null, changed_since_handoff: false, batch_number: null,
  ...over,
});

describe("order-to-cash lifecycle", () => {
  it("places each state on one stage with the team that acts next", () => {
    expect(lifecycle(row({ status: "confirmed", scheduled_start: null }))).toMatchObject({ stage: "scheduling", attention: true, owner: "dispatch" });
    expect(lifecycle(row({ loads_total: 0, fulfillment_gap: "no_loads" }))).toMatchObject({ stage: "dispatch", attention: true, next: "Plan the loads" });
    expect(lifecycle(row())).toMatchObject({ stage: "delivery", attention: false, owner: "none" });
    expect(lifecycle(row({ fulfillment_gap: "quantity_short", loads_not_due: 0 }))).toMatchObject({ stage: "delivery", attention: true, owner: "dispatch" });
    expect(lifecycle(row({ readiness: "needs_review", tickets_pending: 2 }))).toMatchObject({ stage: "tickets", owner: "office", why: "2 tickets not accepted yet." });
    expect(lifecycle(row({ readiness: "missing_documentation", loads_missing: 1 }))).toMatchObject({ stage: "tickets", owner: "office", next: "Enter the missing tickets" });
    expect(lifecycle(row({ readiness: "blocked", exceptions_count: 1 }))).toMatchObject({ stage: "review", owner: "billing", next: "Resolve the exceptions" });
    expect(lifecycle(row({ readiness: "ready", status: "completed", fulfilled: true }))).toMatchObject({ stage: "ready", attention: true, next: "Hand off for billing" });
    expect(lifecycle(row({ readiness: "handed_off", batch_number: "B-2026-0001", handed_off_at: "2026-10-12T15:00:00Z" }))).toMatchObject({ stage: "handed_off", attention: false, owner: "none" });
    expect(lifecycle(row({ readiness: "handed_off", batch_number: "B-2026-0001", changed_since_handoff: true }))).toMatchObject({ stage: "handed_off", attention: true, owner: "billing" });
  });

  it("summarizes counts, attention and value per stage, and waiting days from recorded dates only", () => {
    const rows = [row({ order_id: "a", readiness: "ready", total_cents: 500_00 }), row({ order_id: "b", readiness: "ready", total_cents: 250_00 }), row({ order_id: "c" })];
    const s = summarize(rows);
    expect(s.find((x) => x.stage === "ready")).toEqual({ stage: "ready", total: 2, attention: 2, cents: 750_00 });
    expect(s.find((x) => x.stage === "delivery")).toEqual({ stage: "delivery", total: 1, attention: 0, cents: 100_00 });
    expect(waitingDays(row({ completed_at: "2026-10-08T12:00:00Z" }), "2026-10-13")).toBe(5);
    expect(waitingDays(row({ scheduled_start: "2026-10-20" }), "2026-10-13")).toBe(12); // not started yet: since the order date
  });
});
