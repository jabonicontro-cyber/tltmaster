import { describe, expect, it } from "vitest";
import { dbErrorMessage } from "@/server/errors";

describe("dbErrorMessage", () => {
  it("passes through reasons raised by our database functions", () => {
    expect(dbErrorMessage({ code: "42501", message: "This quote contains a discount… You do not have permission to override pricing." })).toContain("override pricing");
    expect(dbErrorMessage({ code: "P0001", message: "Add at least one line before sending the quote." })).toBe("Add at least one line before sending the quote.");
    expect(dbErrorMessage({ code: "PT409", message: "This quote was changed by someone else." })).toContain("someone else");
  });
  it("hides raw database internals", () => {
    expect(dbErrorMessage({ code: "42501", message: "permission denied for table quotes" })).toBe("You do not have permission to do that.");
    expect(dbErrorMessage({ code: "XX000", message: "internal: relation foo" })).not.toContain("relation");
    expect(dbErrorMessage({ code: "23505", message: 'duplicate key value violates unique constraint "materials_name_key"' })).toBe("A record with the same name or code already exists.");
  });
});
