import { describe, expect, it } from "vitest";
import { BILLING_BLOCKED_HREF, missingTicketKind } from "@/lib/billing/rules";
import { briefingActions, type BriefingSignals } from "@/lib/briefing";
import { metricCards, type CommandSummary } from "@/lib/command-center/rules";
import { DEFAULT_REPORT_VIEW, REPORT_VIEWS, reportViewStatuses, UNRESOLVED_REPORTS_HREF } from "@/lib/driver/rules";

// One count per number (owner walkthrough WK1): a headline figure and the page it opens count the same records, or the
// label says what differs. The database side of each rule is checked in tests/db/headline-counts.test.ts.

describe("missing tickets: the billing board counts like the Command Center", () => {
  it("a load a truck ran without a live ticket is a missing ticket", () => {
    expect(missingTicketKind({ assignment_id: "a1", voided_numbers: null })).toBe("no_ticket");
  });
  it("a load whose ticket was voided and not replaced is a missing ticket, with or without a truck", () => {
    expect(missingTicketKind({ assignment_id: null, voided_numbers: ["1001"] })).toBe("no_ticket");
    expect(missingTicketKind({ assignment_id: "a1", voided_numbers: ["1001"] })).toBe("no_ticket");
  });
  it("a past load that never got a truck is Dispatch's (no ticket to enter), not a missing ticket", () => {
    expect(missingTicketKind({ assignment_id: null, voided_numbers: null })).toBe("no_truck");
  });
});

describe("driver reports: the figure and the page show the same reports", () => {
  it("Not resolved is open plus acknowledged, the page's default view", () => {
    expect(DEFAULT_REPORT_VIEW).toBe("unresolved");
    expect(reportViewStatuses("unresolved")).toEqual(["open", "acknowledged"]);
    expect(reportViewStatuses("open")).toEqual(["open"]);
    expect(reportViewStatuses("resolved")).toEqual(["resolved"]);
    expect(reportViewStatuses("all")).toBeNull();
    expect(Object.keys(REPORT_VIEWS)[0]).toBe("unresolved");
    expect(UNRESOLVED_REPORTS_HREF).toBe("/field-reports?view=unresolved");
  });
});

const summary = (over: Partial<CommandSummary>): CommandSummary => ({
  as_of: "2026-11-11T12:00:00Z", today: "2026-11-11", exceptions: { total: 0, urgent: 0, mine: 0, hidden: 0 }, by_kind: {},
  loads_today: null, loads_today_assigned: null, unassigned_loads: null, assignment_problems: null, trucks_out_of_service: null,
  trailers_out_of_service: null, missing_tickets: null, tickets_to_review: null, billing_blocked: null, billing_ready: null,
  can: { dispatch: true, fleet: true, billing: true, tickets: true, orders: true, assign: true }, ...over,
} as CommandSummary);

describe("Command Center and briefing figures open the view that shows the same count", () => {
  it("driver reports: labelled 'not resolved' and opening Not resolved", () => {
    const card = metricCards(summary({ driver_reports: 2 })).find((c) => c.key === "driver_reports")!;
    expect(card.label).toBe("Driver reports not resolved");
    expect(card.href).toBe(UNRESOLVED_REPORTS_HREF);
  });
  it("orders blocked from billing open Exceptions limited to blocked orders", () => {
    const card = metricCards(summary({ billing_blocked: 6 })).find((c) => c.key === "billing_blocked")!;
    expect(card.href).toBe(BILLING_BLOCKED_HREF);
    expect(new URL(BILLING_BLOCKED_HREF, "http://x").searchParams.get("readiness")).toBe("blocked");
    expect(new URL(BILLING_BLOCKED_HREF, "http://x").searchParams.get("view")).toBe("exceptions");
  });
  it("missing tickets say they are loads that ran", () => {
    expect(metricCards(summary({ missing_tickets: 3 })).find((c) => c.key === "missing_tickets")!.sub).toBe("Loads that ran without a ticket");
  });
  it("the briefing uses the same words and destinations", () => {
    const s: BriefingSignals = {
      urgentOrders: 0, loadsTodayUnassigned: 0, assignmentProblems: 0, trucksDown: 0, driverReports: 2, billingBlocked: 6, billingReady: 0,
      missingTickets: 1, ticketsToReview: 0, tomorrowUnassigned: 0, longWaitsYesterday: 0, overdueInvoices: null, revenueToCheck: null,
    } as BriefingSignals;
    const a = briefingActions(s);
    expect(a.find((x) => x.key === "reports")).toMatchObject({ title: "2 driver reports not resolved", href: UNRESOLVED_REPORTS_HREF });
    expect(a.find((x) => x.key === "blocked")).toMatchObject({ title: "6 orders blocked from billing", href: BILLING_BLOCKED_HREF });
    expect(a.find((x) => x.key === "missing")?.title).toBe("1 load that ran without a ticket");
  });
});
