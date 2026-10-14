import { describe, expect, it } from "vitest";
import { exceptionAction, exceptionOwner, exceptionTitle, metricCards, type CommandSummary, type ExceptionItem } from "@/lib/command-center/rules";
import { zonedTimeToUtc } from "@/lib/dates";
import { orderProgress, type ProgressLoad } from "@/lib/orders/progress";
import { urgencyActions } from "@/lib/orders/urgency";
import type { Permission } from "@/lib/permissions";
import { returnTarget, withReturn } from "@/lib/safe-redirect";

const NOW = new Date("2026-10-12T18:00:00Z");
const load = (over: Partial<ProgressLoad> = {}): ProgressLoad => ({
  id: "11111111-1111-4111-8111-111111111111", status: "planned", load_date: "2026-10-12", ends_at: "2026-10-12T15:00:00Z", assigned: true, tickets: [], ...over,
});
const billing = (readiness: "missing_documentation" | "needs_review" | "blocked" | "in_progress" | "ready" | "handed_off") => ({
  readiness, status: "in_progress", loads_missing: 0, loads_not_due: 0, tickets_live: 1, tickets_pending: 0, exceptions_count: 0,
});

describe("order progress (dispatch → tickets → billing)", () => {
  it("points at the first missing step with who handles it", () => {
    const steps = orderProgress({ orderId: "o1", orderStatus: "scheduled", loads: [load({ assigned: false, ends_at: "2026-10-12T22:00:00Z" })], billing: null, now: NOW });
    expect(steps.map((s) => [s.key, s.state])).toEqual([["dispatch", "attention"], ["tickets", "waiting"], ["billing", "unavailable"]]);
    expect(steps[0]).toMatchObject({ owner: "Dispatch", next: { label: "Assign" } });
    expect(steps[0].next!.href).toContain("load=");
    expect(steps[2].summary).toMatch(/billing access/);
  });

  it("a received ticket is not a verified ticket, and missing tickets come first", () => {
    const received = orderProgress({ orderId: "o1", orderStatus: "in_progress", loads: [load({ tickets: [{ id: "t1", status: "submitted" }] })], billing: billing("needs_review"), now: NOW });
    expect(received[1]).toMatchObject({ state: "attention", owner: "Office (ticket review)" });
    expect(received[1].next!.href).toBe("/tickets/t1?queue=review&order=o1");
    const missing = orderProgress({ orderId: "o1", orderStatus: "in_progress", loads: [load(), load({ id: "l2", tickets: [{ id: "t2", status: "needs_review" }] })], billing: billing("missing_documentation"), now: NOW });
    expect(missing[1].summary).toMatch(/1 delivered load without a ticket\. 1 ticket to review/);
    expect(missing[1].next!.label).toBe("Enter the ticket");
  });

  it("uses the billing view's own due rule (completed orders are due) and never calls billing done before handoff", () => {
    const future = load({ ends_at: "2026-10-13T15:00:00Z", tickets: [{ id: "t1", status: "accepted" }] });
    expect(orderProgress({ orderId: "o1", orderStatus: "in_progress", loads: [future], billing: billing("in_progress"), now: NOW })[1].state).toBe("waiting");
    const done = orderProgress({ orderId: "o1", orderStatus: "completed", loads: [future], billing: billing("ready"), now: NOW });
    expect(done[1].state).toBe("done");
    expect(done[2]).toMatchObject({ state: "attention", next: { label: "Hand off" } });
    expect(orderProgress({ orderId: "o1", orderStatus: "completed", loads: [future], billing: billing("handed_off"), now: NOW })[2].state).toBe("done");
  });

  it("ignores voided tickets and canceled loads", () => {
    const steps = orderProgress({ orderId: "o1", orderStatus: "in_progress", loads: [load({ tickets: [{ id: "t1", status: "voided" }] }), load({ id: "l2", status: "canceled", assigned: false })], billing: null, now: NOW });
    expect(steps[0].state).toBe("done");
    expect(steps[1].state).toBe("attention");
  });
});

describe("business time", () => {
  it("converts wall-clock business time to UTC across daylight saving", () => {
    expect(zonedTimeToUtc("2026-07-01", "07:00", "America/Chicago")).toBe("2026-07-01T12:00:00.000Z"); // CDT
    expect(zonedTimeToUtc("2026-12-01", "07:00", "America/Chicago")).toBe("2026-12-01T13:00:00.000Z"); // CST
    expect(zonedTimeToUtc("2026-07-01", "07:00", "America/Phoenix")).toBe("2026-07-01T14:00:00.000Z"); // no DST
    expect(zonedTimeToUtc("2026-02-30", "07:00", "America/Chicago")).toBeNull();
    expect(zonedTimeToUtc("2026-07-01", "25:00", "America/Chicago")).toBeNull();
  });
});

describe("returning to the queue", () => {
  it("accepts only known in-app list pages with their filters", () => {
    expect(returnTarget("/command-center?kind=ticket_review&page=2#attention")).toEqual({ href: "/command-center?kind=ticket_review&page=2#attention", label: "Back to the Command Center" });
    expect(returnTarget("/tickets?view=review")?.label).toBe("Back to the ticket queue");
    for (const bad of ["https://evil.example/", "//evil.example", "/\\evil", "/settings", "/tickets/abc", "/command-centerx", undefined, ""]) {
      expect(returnTarget(bad), String(bad)).toBeNull();
    }
    expect(withReturn("/tickets/1?queue=review", "/command-center?mine=1#attention")).toBe("/tickets/1?queue=review&back=%2Fcommand-center%3Fmine%3D1%23attention");
    expect(withReturn("/dispatch#needs-scheduling", "/command-center")).toBe("/dispatch?back=%2Fcommand-center#needs-scheduling");
  });
});

describe("urgent orders", () => {
  const as = (perms: Permission[]) => (p: Permission) => perms.includes(p);
  it("offers each role only the moves the database allows", () => {
    expect(urgencyActions("awaiting_acknowledgement", as(["dispatch.edit"])).map((a) => a.state)).toEqual(["acknowledged", "evaluating", "waiting_for_information", "blocked", "assigned", "resolved"]);
    expect(urgencyActions("acknowledged", as(["orders.edit"])).map((a) => a.state)).toEqual(["resolved", "canceled"]);
    expect(urgencyActions("blocked", as(["fleet.view"]))).toEqual([]);
    expect(urgencyActions("resolved", as(["dispatch.edit", "orders.edit"]))).toEqual([]);
  });

  const item = (details: Record<string, unknown>, extra: Partial<ExceptionItem> = {}): ExceptionItem => ({
    exception_key: "urgent_order:x", kind: "urgent_order", priority: 1, since: null, order_id: "o1", order_number: "O-2026-0001", customer_name: "Riverbend Builders (test)",
    load_id: null, load_number: null, load_date: null, ticket_id: null, ticket_number: null, equipment_kind: null, equipment_id: null, unit_number: null, assignment_id: null,
    reasons: ["urgent_awaiting_acknowledgement"], details, assigned_to: null, assignee_name: null, assigned_at: null, assignment_note: null, ...extra,
  });

  it("explains an urgent order: what, who acts next, and where to act", () => {
    const e = item({ state: "awaiting_acknowledgement", reason: "Pour moved up" });
    expect(exceptionTitle(e)).toBe("O-2026-0001 is urgent — awaiting acknowledgement");
    expect(exceptionOwner(e)).toBe("Dispatch: acknowledge it");
    expect(exceptionAction(e, { ticketsEdit: false, dispatch: true })).toEqual({ label: "Open and acknowledge", href: "/orders/o1" });
    expect(exceptionOwner(item({ state: "evaluating", acknowledged_by_name: "Dana" }))).toBe("Dispatch: decide and assign (acknowledged by Dana)");
    expect(exceptionOwner(item({ state: "evaluating" }, { assignee_name: "Sam" }))).toBe("Sam");
  });

  it("shows urgent orders and today's orders as cards only when the summary includes them", () => {
    const base = {
      as_of: "", today: "2026-10-12", exceptions: { total: 0, urgent: 0, mine: 0 }, by_kind: {},
      loads_today: null, loads_today_assigned: null, unassigned_loads: null, assignment_problems: null, trucks_out_of_service: null,
      trailers_out_of_service: null, tickets_to_review: null, missing_tickets: null, billing_blocked: null, billing_ready: null,
      can: { dispatch: false, fleet: false, billing: false, tickets: false, assign: false },
    } satisfies CommandSummary;
    expect(metricCards(base).map((c) => c.key)).toEqual([]);
    const cards = metricCards({ ...base, urgent_orders: 2, orders_today: 0 });
    expect(cards.map((c) => [c.key, c.value, c.tone])).toEqual([["urgent_orders", 2, "bad"], ["orders_today", 0, "default"]]);
  });
});
