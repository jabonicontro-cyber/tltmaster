import { describe, expect, it } from "vitest";
import { buildOrderTimeline, describeChanges } from "@/lib/orders/history";
import { formatScheduleDates, formatTime, formatWindow, isPastRequested } from "@/lib/orders/schedule";
import {
  allowedOrderTransitions,
  canEditOrderDetails,
  canEditOrderLines,
  canTransitionOrder,
  OPEN_ORDER_STATUSES,
  ORDER_STATUSES,
  orderTransitionLabel,
  orderTransitionNeedsReason,
  orderTransitionNeedsSchedule,
  orderTransitionPermission,
} from "@/lib/orders/status";
import { orderDetailsInput, orderDraftInput, orderScheduleInput, toOrderSchedulePayload } from "@/lib/schemas/order";

describe("order status rules", () => {
  it("completed and canceled are final; everything else can move on", () => {
    for (const s of ORDER_STATUSES) {
      const final = s === "completed" || s === "canceled";
      expect(allowedOrderTransitions(s).length === 0, s).toBe(final);
      expect(OPEN_ORDER_STATUSES.includes(s), s).toBe(!final);
    }
  });

  it("follows the documented happy path and refuses skipping steps", () => {
    const path = ["draft", "confirmed", "scheduled", "dispatched", "in_progress", "completed"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransitionOrder(path[i], path[i + 1])).toBe(true);
    expect(canTransitionOrder("draft", "scheduled")).toBe(false);
    expect(canTransitionOrder("confirmed", "completed")).toBe(false);
    expect(canTransitionOrder("in_progress", "canceled")).toBe(false);
    expect(canTransitionOrder("canceled", "confirmed")).toBe(false);
  });

  it("maps transitions to permissions", () => {
    expect(orderTransitionPermission("draft", "confirmed")).toBe("orders.edit");
    expect(orderTransitionPermission("scheduled", "canceled")).toBe("orders.edit");
    expect(orderTransitionPermission("confirmed", "scheduled")).toBe("orders.schedule");
    expect(orderTransitionPermission("on_hold", "confirmed")).toBe("orders.schedule");
    expect(orderTransitionPermission("in_progress", "completed")).toBe("orders.schedule");
  });

  it("knows which transitions need a reason or a date", () => {
    expect(orderTransitionNeedsReason("on_hold")).toBe(true);
    expect(orderTransitionNeedsReason("canceled")).toBe(true);
    expect(orderTransitionNeedsReason("completed")).toBe(false);
    expect(orderTransitionNeedsSchedule("scheduled")).toBe(true);
    expect(orderTransitionNeedsSchedule("confirmed")).toBe(false);
  });

  it("only direct drafts have editable lines; details are editable until final", () => {
    expect(canEditOrderLines("draft", null)).toBe(true);
    expect(canEditOrderLines("draft", "q1")).toBe(false);
    expect(canEditOrderLines("confirmed", null)).toBe(false);
    expect(canEditOrderDetails("in_progress")).toBe(true);
    expect(canEditOrderDetails("completed")).toBe(false);
  });

  it("labels actions by context", () => {
    expect(orderTransitionLabel("draft", "confirmed")).toBe("Confirm order");
    expect(orderTransitionLabel("scheduled", "confirmed")).toBe("Unschedule");
    expect(orderTransitionLabel("dispatched", "scheduled")).toBe("Recall to scheduled");
    expect(orderTransitionLabel("partially_completed", "in_progress")).toBe("Resume work");
  });
});

describe("schedule display", () => {
  it("formats times, ranges and windows", () => {
    expect(formatTime("07:05:00")).toBe("7:05 AM");
    expect(formatTime("12:00")).toBe("12:00 PM");
    expect(formatTime("00:30")).toBe("12:30 AM");
    expect(formatScheduleDates("2026-10-15", null)).toBe("Oct 15, 2026");
    expect(formatScheduleDates("2026-10-15", "2026-10-16")).toBe("Oct 15, 2026 – Oct 16, 2026");
    expect(formatScheduleDates(null, null)).toBe("");
    expect(formatWindow("07:00:00", "11:30:00")).toBe("7:00 AM – 11:30 AM");
    expect(formatWindow("07:00:00", null)).toBe("");
  });

  it("flags orders that will miss the requested date", () => {
    const today = "2026-10-12";
    expect(isPastRequested({ requested_date: "2026-10-10", scheduled_start: null, status: "confirmed" }, today)).toBe(true);
    expect(isPastRequested({ requested_date: "2026-10-14", scheduled_start: null, status: "confirmed" }, today)).toBe(false);
    expect(isPastRequested({ requested_date: "2026-10-14", scheduled_start: "2026-10-15", status: "scheduled" }, today)).toBe(true);
    expect(isPastRequested({ requested_date: "2026-10-14", scheduled_start: "2026-10-14", status: "scheduled" }, today)).toBe(false);
    expect(isPastRequested({ requested_date: "2026-10-10", scheduled_start: null, status: "completed" }, today)).toBe(false);
  });
});

describe("order history", () => {
  it("describes field changes, hiding ids and long text values", () => {
    const c = describeChanges({
      customer_po: { from: "", to: "PO-1" },
      internal_notes: { from: "a", to: "b" },
      window_start: { from: null, to: "07:00:00" },
      unknown_field: { from: 1, to: 2 },
    });
    expect(c).toEqual([
      { field: "customer_po", label: "Customer PO", from: "—", to: "PO-1" },
      { field: "internal_notes", label: "Internal notes", from: null, to: null },
      { field: "window_start", label: "Window from", from: "—", to: "07:00" },
    ]);
  });

  it("merges status events with edits, newest first, without duplicating status changes", () => {
    const t = buildOrderTimeline(
      [{ id: "e1", occurred_at: "2026-10-12T10:00:00Z", actor_id: null, from_status: "draft", to_status: "confirmed", note: "" }],
      [
        { id: "a1", occurred_at: "2026-10-12T10:00:00Z", actor_id: null, action: "order.status_changed", summary: "x", details: {} },
        { id: "a2", occurred_at: "2026-10-12T11:00:00Z", actor_id: null, action: "order.updated", summary: "O-1 details changed", details: { changes: { project_name: { from: "", to: "Lot" } } } },
      ],
    );
    expect(t.map((e) => e.id)).toEqual(["a2", "e1"]);
  });
});

describe("order input validation", () => {
  const base = { orderId: "00000000-0000-4000-8000-000000000001", expectedEditSeq: 3 };

  it("validates the schedule", () => {
    expect(orderScheduleInput.safeParse({ ...base, scheduledStart: "2026-10-15", scheduledEnd: "2026-10-14" }).success).toBe(false);
    expect(orderScheduleInput.safeParse({ ...base, scheduledEnd: "2026-10-14" }).success).toBe(false);
    expect(orderScheduleInput.safeParse({ ...base, scheduledStart: "2026-10-15", windowStart: "09:00" }).success).toBe(false);
    expect(orderScheduleInput.safeParse({ ...base, scheduledStart: "2026-10-15", windowStart: "09:00", windowEnd: "08:00" }).success).toBe(false);
    expect(orderScheduleInput.safeParse({ ...base, scheduledStart: "2026-02-30" }).success).toBe(false);
    const ok = orderScheduleInput.parse({ ...base, scheduledStart: "2026-10-15", windowStart: "07:00", windowEnd: "11:30", schedulingNotes: "  Gate code 1234 " });
    expect(toOrderSchedulePayload(ok)).toEqual({ scheduled_start: "2026-10-15", scheduled_end: null, window_start: "07:00", window_end: "11:30", scheduling_notes: "Gate code 1234" });
  });

  it("validates direct orders and details", () => {
    const draft = { customerId: "00000000-0000-4000-8000-000000000002", orderDate: "2026-10-12", lines: [] };
    expect(orderDraftInput.safeParse(draft).success).toBe(true);
    expect(orderDraftInput.safeParse({ ...draft, requestedDate: "2026-10-11" }).success).toBe(false);
    expect(orderDraftInput.safeParse({ ...draft, taxRate: "30" }).success).toBe(false);
    expect(orderDetailsInput.safeParse({ ...base, contactEmail: "not-an-email" }).success).toBe(false);
    expect(orderDetailsInput.safeParse({ ...base, saveSite: true }).success).toBe(false);
  });
});
