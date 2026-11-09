import { describe, expect, it } from "vitest";
import { acknowledgementChange, billingBlockers, completionSteps, type BlockerInput, type ExceptionLike } from "@/lib/billing/blockers";
import { readinessExplanation } from "@/lib/billing/rules";

// Office walkthrough 2026-11-09: every blocker of an order at once, why an acknowledgement stopped counting, and the
// status steps that complete an order from its billing page.

const base: BlockerInput = {
  readiness: "in_progress", status: "scheduled", fulfilled: false, fulfillment_gap: "quantity_short",
  loads_missing: 0, tickets_live: 1, tickets_pending: 0, exceptions_count: 0, acknowledgment_id: null,
};

describe("billingBlockers", () => {
  it("lists nothing for a ready or handed-off order", () => {
    expect(billingBlockers({ ...base, readiness: "ready", exceptions_count: 2 })).toEqual([]);
    expect(billingBlockers({ ...base, readiness: "handed_off" })).toEqual([]);
  });

  it("lists every blocker at once, in the order a person fixes them", () => {
    const b = billingBlockers({ ...base, loads_missing: 3, tickets_pending: 2, exceptions_count: 1 }, { unassignedMissing: 1 });
    expect(b.map((x) => x.key)).toEqual(["missing_tickets", "unassigned_loads", "tickets_to_check", "not_completed", "exceptions"]);
    expect(b[0].title).toBe("2 delivered loads without a delivery ticket");
    expect(b[1].title).toBe("1 load never assigned a truck");
    expect(b[1].detail).toMatch(/Dispatch assigns/);
    expect(b[2].title).toBe("2 tickets not accepted yet");
    expect(b[3].detail).toContain("delivered less than ordered");
  });

  it("asks to acknowledge only after completing, since completing can add differences", () => {
    const early = billingBlockers({ ...base, readiness: "blocked", exceptions_count: 1 }).find((x) => x.key === "exceptions")!;
    expect(early.actionable).toBe(false);
    expect(early.detail).toMatch(/once the order is completed/);
    const done = billingBlockers({ ...base, readiness: "blocked", status: "completed", exceptions_count: 2 });
    expect(done.map((x) => x.key)).toEqual(["exceptions"]);
    expect(done[0]).toMatchObject({ actionable: true, title: "2 differences to acknowledge" });
  });

  it("a fully delivered order needs no completion; an acknowledged one no acknowledgement", () => {
    expect(billingBlockers({ ...base, fulfilled: true, tickets_pending: 1, readiness: "needs_review" }).map((x) => x.key)).toEqual(["tickets_to_check"]);
    expect(billingBlockers({ ...base, status: "completed", readiness: "blocked", exceptions_count: 1, acknowledgment_id: "a" })).toEqual([]);
  });

  it("a completed order without tickets says so", () => {
    expect(billingBlockers({ ...base, status: "completed", readiness: "missing_documentation", tickets_live: 0 }).map((x) => x.key)).toEqual(["no_tickets"]);
  });

  it("explains a changed acknowledgement in the exceptions step", () => {
    const b = billingBlockers({ ...base, status: "completed", readiness: "blocked", exceptions_count: 1 }, { ackChange: "The delivered amounts changed since you acknowledged them. Check them again and acknowledge." });
    expect(b[0].detail).toBe("The delivered amounts changed since you acknowledged them. Check them again and acknowledge.");
  });
});

describe("acknowledgementChange", () => {
  const load: ExceptionLike = { kind: "load_quantity", load_id: "L1", line_id: null, load_number: 1, expected_quantity: "22", actual_quantity: "21.7" };
  const line: ExceptionLike = { kind: "line_quantity", load_id: null, line_id: "X1", line_no: 1, expected_quantity: "22", actual_quantity: "21.7" };

  it("names differences that are new since the acknowledgement", () => {
    expect(acknowledgementChange([load], [load, line])).toBe("New since you acknowledged: Order line: delivered differs from ordered, line 1. Check them again and acknowledge.");
  });

  it("says when the delivered amounts changed", () => {
    expect(acknowledgementChange([load], [{ ...load, actual_quantity: "21.9" }])).toBe("The delivered amounts changed since you acknowledged them. Check them again and acknowledge.");
  });

  it("treats 21.70 and 21.7 as the same amount, and falls back to a general sentence", () => {
    expect(acknowledgementChange([load, line], [{ ...load, actual_quantity: "21.70" }])).toBe("The differences changed since you acknowledged them. Check them again and acknowledge.");
  });
});

describe("completionSteps", () => {
  it("follows the status rules: started first, then completed; never skipped", () => {
    expect(completionSteps("in_progress")).toEqual(["completed"]);
    expect(completionSteps("partially_completed")).toEqual(["completed"]);
    expect(completionSteps("scheduled")).toEqual(["in_progress", "completed"]);
    expect(completionSteps("dispatched")).toEqual(["in_progress", "completed"]);
    expect(completionSteps("completed")).toEqual([]);
    expect(completionSteps("confirmed")).toBeNull();
    expect(completionSteps("on_hold")).toBeNull();
    expect(completionSteps("canceled")).toBeNull();
  });
});

describe("readinessExplanation after the handoff", () => {
  const counts = { status: "completed", loads_missing: 0, loads_not_due: 0, tickets_live: 1, tickets_pending: 0, exceptions_count: 0 };
  it("follows the company's invoicing setting", () => {
    expect(readinessExplanation("handed_off", counts, "taviron")).toMatchObject({ next: "Create the invoice" });
    expect(readinessExplanation("handed_off", counts, "taviron").action).toMatch(/create the invoice/);
    expect(readinessExplanation("handed_off", counts, "quickbooks").action).toMatch(/accounting system/);
    expect(readinessExplanation("handed_off", counts).next).toBe("Enter the invoice in accounting");
  });
});

describe("ticket list views (To check)", async () => {
  const { ticketViewFromParams, queueFilter, TICKET_VIEWS } = await import("@/server/data/tickets");
  it("one office queue, with old links opening the matching filter", () => {
    expect(Object.values(TICKET_VIEWS)).toContain("To check");
    expect(ticketViewFromParams("review", undefined)).toEqual({ view: "check", show: "flagged" });
    expect(ticketViewFromParams("submitted", undefined)).toEqual({ view: "check", show: "new" });
    expect(ticketViewFromParams("check", "nope")).toEqual({ view: "check", show: "all" });
    expect(ticketViewFromParams(undefined, undefined)).toEqual({ view: "awaiting", show: "all" });
  });
  it("a ticket opened from a filter keeps that filter's queue", () => {
    expect(queueFilter("review")).toBe("all");
    expect(queueFilter("flagged")).toBe("flagged");
    expect(queueFilter("new")).toBe("new");
    expect(queueFilter(undefined)).toBeNull();
    expect(queueFilter("other")).toBeNull();
  });
});
