import { describe, expect, it } from "vitest";
import {
  EXCEPTION_KINDS, ageLabel, exceptionAction, exceptionReasons, exceptionTitle, knowsReason, metricCards, reasonText,
  type CommandSummary, type ExceptionItem,
} from "@/lib/command-center/rules";

const base: ExceptionItem = {
  exception_key: "x",
  kind: "missing_ticket",
  priority: 2,
  since: null,
  order_id: "o1",
  order_number: "O-2026-0007",
  customer_name: "Prairie View Landscaping",
  load_id: "l1",
  load_number: 2,
  load_date: "2026-10-09",
  ticket_id: null,
  ticket_number: null,
  equipment_kind: null,
  equipment_id: null,
  unit_number: null,
  assignment_id: "a1",
  reasons: ["no_ticket"],
  details: {},
  assigned_to: null,
  assignee_name: null,
  assigned_at: null,
  assignment_note: null,
};
const all = { ticketsEdit: true, dispatch: true };

describe("links into the existing workflows", () => {
  it("sends each kind to the module that resolves it", () => {
    expect(exceptionAction(base, all)).toEqual({ label: "Enter the ticket", href: "/tickets/new?load=l1" });
    expect(exceptionAction({ ...base, assignment_id: null }, all)).toEqual({ label: "Assign or cancel the load", href: "/dispatch?date=2026-10-09&load=l1" });
    expect(exceptionAction(base, { ticketsEdit: false, dispatch: false }).href).toBe("/billing/orders/o1");
    expect(exceptionAction({ ...base, kind: "unassigned_load" }, all).href).toBe("/dispatch?date=2026-10-09&load=l1");
    expect(exceptionAction({ ...base, kind: "assignment_problem" }, all).label).toBe("Reassign the load");
    expect(exceptionAction({ ...base, kind: "ticket_review", ticket_id: "t1" }, all).href).toBe("/tickets/t1?queue=review"); // opens in the review queue
    expect(exceptionAction({ ...base, kind: "billing_blocked" }, all).href).toBe("/billing/orders/o1");
    expect(exceptionAction({ ...base, kind: "equipment_out_of_service", equipment_kind: "trailer", equipment_id: "e1" }, all).href).toBe("/fleet/trailers/e1");
    expect(exceptionAction({ ...base, kind: "equipment_out_of_service", equipment_kind: "truck", equipment_id: "e2" }, all).href).toBe("/fleet/trucks/e2");
    expect(exceptionAction({ ...base, kind: "delay_report", details: { report_id: "r1" } }, all)).toEqual({ label: "Open the report", href: "/field-reports/r1" });
    expect(exceptionTitle({ ...base, kind: "equipment_report", equipment_kind: "trailer", unit_number: "T7", details: { driver_name: "Drew" } })).toBe("Drew reported a problem with trailer T7 (O-2026-0007 · load 2)");
  });

  it("names the affected record and explains every reason", () => {
    expect(exceptionTitle(base)).toBe("O-2026-0007 · load 2 has no delivery ticket");
    expect(exceptionTitle({ ...base, kind: "ticket_review", ticket_number: "T-2026-00004", details: { status: "needs_review" } })).toBe("Ticket T-2026-00004 (O-2026-0007 · load 2) needs review");
    expect(exceptionTitle({ ...base, kind: "equipment_out_of_service", equipment_kind: "truck", unit_number: "101" })).toBe("Truck 101 is out of service");
    const eq = exceptionReasons({ ...base, kind: "equipment_out_of_service", reasons: ["out_of_service"], details: { reason: "Brakes", expected_return_date: "2026-10-12", upcoming_loads: 2 } });
    expect(eq).toEqual(["Marked out of service.", "Reason: Brakes", "Expected back Oct 12, 2026.", "2 upcoming loads are still booked on it."]);
    for (const code of ["no_ticket", "ticket_voided", "not_assigned", "no_assignment", "assignment_removed", "awaiting_acceptance", "flagged_for_review",
      "exceptions_unacknowledged", "acknowledgment_outdated", "out_of_service", "load_outside_schedule", "truck_out_of_service", "cdl_expired",
      "unit_differs_from_order_line", "missing_external_reference"]) {
      expect(knowsReason(code), code).toBe(true);
      expect(reasonText(code), code).not.toBe(code);
    }
    expect(knowsReason("made_up_code")).toBe(false);
  });
});

describe("age", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  it("is shown only when known", () => {
    expect(ageLabel(null, now)).toBeNull();
    expect(ageLabel("not a date", now)).toBeNull();
    expect(ageLabel("2026-10-10T11:58:00Z", now)).toBe("2 min");
    expect(ageLabel("2026-10-10T03:00:00Z", now)).toBe("9 h");
    expect(ageLabel("2026-10-07T12:00:00Z", now)).toBe("3 d");
    expect(ageLabel("2026-10-10T13:00:00Z", now)).toBe("upcoming");
  });
});

describe("overview cards", () => {
  const summary = (over: Partial<CommandSummary>): CommandSummary => ({
    as_of: "2026-10-10T12:00:00Z",
    today: "2026-10-10",
    exceptions: { total: 0, urgent: 0, mine: 0 },
    by_kind: {},
    loads_today: null,
    loads_today_assigned: null,
    unassigned_loads: null,
    assignment_problems: null,
    trucks_out_of_service: null,
    trailers_out_of_service: null,
    tickets_to_review: null,
    missing_tickets: null,
    billing_blocked: null,
    billing_ready: null,
    can: { dispatch: false, fleet: false, billing: false, tickets: false, assign: false },
    ...over,
  });

  it("hides what the role may not see instead of showing zero", () => {
    expect(metricCards(summary({}))).toEqual([]);
    const mechanic = metricCards(summary({ trucks_out_of_service: 2, trailers_out_of_service: 1 }));
    expect(mechanic.map((c) => c.key)).toEqual(["out_of_service", "maintenance"]);
    expect(mechanic.find((c) => c.key === "maintenance")).toMatchObject({ value: null, href: null });
  });

  it("links every metric to a filtered list", () => {
    const cards = metricCards(summary({ loads_today: 5, loads_today_assigned: 4, unassigned_loads: 1, assignment_problems: 0, trucks_out_of_service: 0, trailers_out_of_service: 0, missing_tickets: 3, tickets_to_review: 2, billing_blocked: 1, billing_ready: 4 }));
    expect(cards.map((c) => [c.key, c.href])).toEqual([
      ["loads_today", "/dispatch?date=2026-10-10"],
      ["unassigned_loads", "/command-center?kind=unassigned_load#attention"],
      ["assignment_problems", "/command-center?kind=assignment_problem#attention"],
      ["out_of_service", "/command-center?kind=equipment_out_of_service#attention"],
      ["maintenance", null],
      ["missing_tickets", "/command-center?kind=missing_ticket#attention"],
      ["tickets_to_review", "/command-center?kind=ticket_review#attention"],
      ["billing_blocked", "/billing?view=exceptions"],
      ["billing_ready", "/billing?view=ready"],
    ]);
    expect(cards.find((c) => c.key === "unassigned_loads")?.tone).toBe("bad");
    expect(cards.find((c) => c.key === "assignment_problems")?.tone).toBe("default");
    expect(EXCEPTION_KINDS).toHaveLength(10); // incl. urgent_order (N10), order_unscheduled (N14)
    expect(metricCards(summary({ driver_reports: 2 })).map((c) => [c.key, c.href, c.tone])).toEqual([["driver_reports", "/field-reports", "bad"]]);
  });
});
