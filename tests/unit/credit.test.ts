import { describe, expect, it } from "vitest";
import { holdSummary } from "@/lib/credit";

describe("credit hold wording (B128)", () => {
  it("names every reason and the billing note only for a manual hold", () => {
    expect(holdSummary({ reasons: ["manual"], note: "Two invoices 60 days late" })).toBe("on credit hold (put on hold by billing) — Two invoices 60 days late");
    expect(holdSummary({ reasons: ["overdue", "over_limit"], note: "" })).toBe("on credit hold (invoices past due, over the credit limit)");
    expect(holdSummary({ reasons: ["overdue"], note: "left from an earlier hold" })).toBe("on credit hold (invoices past due)");
  });
});
