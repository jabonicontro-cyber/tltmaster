import { describe, expect, it } from "vitest";
import { lineProgress } from "@/lib/tickets/context";
import { REVIEW_REASON_HELP, REVIEW_REASON_LABELS } from "@/lib/tickets/rules";

describe("order line progress for a ticket under review", () => {
  const line = { unit_code: "ton", quantity: "40" };
  it("adds verified tickets in the line's unit only, exactly (thousandths), and shows this ticket separately", () => {
    const p = lineProgress(line, [
      { id: "a", status: "accepted", quantity: "21.47", unit_code: "ton" },
      { id: "b", status: "submitted", quantity: "5", unit_code: "ton" },
      { id: "c", status: "accepted", quantity: "3", unit_code: "load" },
      { id: "d", status: "voided", quantity: "99", unit_code: "ton" },
      { id: "me", status: "needs_review", quantity: "18.53", unit_code: "ton" },
    ], "me");
    expect(p).toEqual({ unit: "ton", ordered: "40", verifiedOthers: "21.47", pendingOthers: "5", thisTicket: "18.53", afterThis: "40", remainingAfterThis: "0", over: false, otherUnitTickets: 1 });
  });

  it("says when a ticket would take the line over the order, and when the ticket is in another unit", () => {
    expect(lineProgress(line, [{ id: "a", status: "accepted", quantity: "30", unit_code: "ton" }, { id: "me", status: "submitted", quantity: "12.5", unit_code: "ton" }], "me")).toMatchObject({ afterThis: "42.5", remainingAfterThis: "-2.5", over: true });
    expect(lineProgress(line, [{ id: "me", status: "submitted", quantity: "2", unit_code: "load" }], "me")).toMatchObject({ thisTicket: null, otherUnitTickets: 1, remainingAfterThis: "40" });
    expect(lineProgress(line, [], "")).toMatchObject({ verifiedOthers: "0", remainingAfterThis: "40" });
  });
});

describe("review reasons", () => {
  it("every reason the database raises explains why it matters, what to do next and who handles it", () => {
    for (const code of Object.keys(REVIEW_REASON_LABELS)) {
      const h = REVIEW_REASON_HELP[code];
      expect(h, code).toBeDefined();
      expect(h.why.length && h.next.length && h.who.length, code).toBeTruthy();
    }
  });
});
