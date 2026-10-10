import { describe, expect, it } from "vitest";
import { isLiveTicket, quantityError, reviewReasonLabel, TICKET_STATUS_LABELS, TICKET_STATUSES, unitRequiresWhole } from "@/lib/tickets/rules";

describe("delivered quantity validation", () => {
  it("requires a finite positive number with at most 3 decimals and never defaults", () => {
    expect(quantityError("", "ton")).toMatch(/Enter the delivered quantity/);
    expect(quantityError("   ", "ton")).toMatch(/Enter the delivered quantity/);
    for (const bad of ["0", "0.000"]) expect(quantityError(bad, "ton"), bad).toMatch(/greater than 0/);
    for (const bad of ["-1", "abc", "1e3", "NaN", "Infinity", "1.2345", "1,000", "1.", ".5", "1234567"]) {
      expect(quantityError(bad, "ton"), bad).toMatch(/at most 3 decimals/);
    }
    expect(quantityError("21.47", "ton")).toBeNull();
    expect(quantityError("999999.999", "ton")).toBeNull();
    expect(quantityError(" 18 ", "cu_yd")).toBeNull();
  });

  it("requires whole numbers for loads and each", () => {
    expect(unitRequiresWhole("load")).toBe(true);
    expect(unitRequiresWhole("each")).toBe(true);
    expect(unitRequiresWhole("ton")).toBe(false);
    expect(quantityError("2.5", "load")).toMatch(/whole numbers/);
    expect(quantityError("2", "load")).toBeNull();
    expect(quantityError("2.000", "each")).toBeNull();
    // Without a unit the number itself can still be checked.
    expect(quantityError("2.5", null)).toBeNull();
  });
});

describe("statuses and reasons", () => {
  it("labels every status and treats voided and superseded as not live", () => {
    for (const s of TICKET_STATUSES) expect(TICKET_STATUS_LABELS[s]).toBeTruthy();
    expect(TICKET_STATUSES.filter(isLiveTicket)).toEqual(["submitted", "needs_review", "accepted"]);
  });

  it("explains review reasons and passes unknown codes through", () => {
    expect(reviewReasonLabel("unit_differs_from_order_line")).toMatch(/no conversion/);
    expect(reviewReasonLabel("something_new")).toBe("something_new");
  });
});
