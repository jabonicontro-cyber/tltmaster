import { describe, expect, it } from "vitest";
import { noticeMessage } from "@/lib/subscription/notices";

// Subscription notices (SUB1): the customer email for each recorded event; platform-only events send nothing.

describe("subscription notice messages", () => {
  it("renewal reminder names the date and how to stop it", () => {
    const m = noticeMessage({ kind: "renewal_reminder", company: "Ridge Haul", detail: { renews_on: "2027-03-01", days_before: 30, plan: "Growth" } })!;
    expect(m.subject).toBe("Your Taviron subscription renews on March 1, 2027");
    expect(m.paragraphs.join(" ")).toMatch(/Growth/);
    expect(m.paragraphs.join(" ")).toMatch(/turn renewal off/);
  });

  it("over the plan: counts against the limits, the grace end, and that nothing changes without notice", () => {
    const m = noticeMessage({ kind: "over_limit", company: "Ridge Haul", detail: { trucks: 16, limit_trucks: 15, bases: 1, limit_bases: 1, grace_ends_on: "2027-02-05" } })!;
    const text = m.paragraphs.join(" ");
    expect(text).toMatch(/16 trucks \(your plan covers 15\)/);
    expect(text).toMatch(/February 5, 2027/);
    expect(text).toMatch(/before anything changes/);
  });

  it("a scheduled change states plan, date, price and why", () => {
    const m = noticeMessage({ kind: "tier_change_scheduled", company: "Ridge Haul", detail: { plan: "Professional", effective_on: "2027-04-01", agreed_monthly_cents: 129900, reason: "Over the plan for 30 days." } })!;
    expect(m.subject).toBe("Your Taviron plan changes on April 1, 2027");
    expect(m.paragraphs[0]).toBe("Ridge Haul moves to the Professional plan from April 1, 2027, at $1,299.00 per month.");
    expect(m.paragraphs[1]).toBe("Why: Over the plan for 30 days.");
  });

  it("platform-only events have no customer email", () => {
    expect(noticeMessage({ kind: "tier_change_due", company: "Ridge Haul", detail: {} })).toBeNull();
  });
});
