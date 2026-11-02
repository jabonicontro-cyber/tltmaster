import { describe, expect, it } from "vitest";
import { briefingActions, greetingFor, type BriefingSignals } from "@/lib/briefing";

const none: BriefingSignals = {
  urgentOrders: 0, loadsTodayUnassigned: 0, assignmentProblems: 0, trucksDown: 0, driverReports: 0, ticketsToReview: 0, missingTickets: 0,
  billingReady: 0, billingBlocked: 0, overdueInvoices: { count: 0, cents: 0 }, revenueToCheck: { count: 0, cents: 0 }, tomorrowUnassigned: 0, longWaitsYesterday: 0,
};

describe("morning briefing", () => {
  it("nothing to do on a quiet day; signals the viewer cannot see produce nothing", () => {
    expect(briefingActions(none)).toEqual([]);
    expect(briefingActions({ ...none, urgentOrders: null, overdueInvoices: null })).toEqual([]);
  });

  it("ranks safety and today's work before money, and money by size", () => {
    const a = briefingActions({ ...none, ticketsToReview: 3, urgentOrders: 1, overdueInvoices: { count: 2, cents: 1_250_000 }, revenueToCheck: { count: 4, cents: 50_000 }, loadsTodayUnassigned: 2 });
    expect(a.map((x) => x.key)).toEqual(["urgent", "unassigned", "overdue", "revenue", "review"]);
    expect(a[2].title).toBe("$12,500 overdue on 2 invoices");
    expect(a[0].title).toBe("1 urgent order waiting");
    expect(a.every((x) => x.href.startsWith("/"))).toBe(true);
  });

  it("greets by the hour", () => {
    expect(greetingFor(6)).toBe("Good morning");
    expect(greetingFor(13)).toBe("Good afternoon");
    expect(greetingFor(19)).toBe("Good evening");
  });
});
