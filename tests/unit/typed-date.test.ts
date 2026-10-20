import { describe, expect, it } from "vitest";
import { isoToTyped, parseTypedDate } from "@/lib/dates";

// Typed dates on the Reports period (and any TypedDateInput): MM/DD/YYYY, never silently moved to another day.
describe("parseTypedDate", () => {
  it("reads MM/DD/YYYY and the usual variations", () => {
    expect(parseTypedDate("10/19/2026")).toEqual({ ok: true, iso: "2026-10-19" });
    expect(parseTypedDate(" 1/5/2026 ")).toEqual({ ok: true, iso: "2026-01-05" });
    expect(parseTypedDate("10-19-2026")).toEqual({ ok: true, iso: "2026-10-19" });
    expect(parseTypedDate("10.19.2026")).toEqual({ ok: true, iso: "2026-10-19" });
    expect(parseTypedDate("10/19/26")).toEqual({ ok: true, iso: "2026-10-19" });
    expect(parseTypedDate("2026-10-19")).toEqual({ ok: true, iso: "2026-10-19" });
  });

  it("checks month lengths and leap years instead of rolling over", () => {
    expect(parseTypedDate("02/29/2028")).toEqual({ ok: true, iso: "2028-02-29" });
    expect(parseTypedDate("02/29/2026")).toMatchObject({ ok: false, error: "02/2026 has 28 days." });
    expect(parseTypedDate("02/29/2100", "2000-01-01", "2100-12-31")).toMatchObject({ ok: false });
    expect(parseTypedDate("02/29/2000")).toEqual({ ok: true, iso: "2000-02-29" });
    expect(parseTypedDate("04/31/2026")).toMatchObject({ ok: false, error: "04/2026 has 30 days." });
    expect(parseTypedDate("13/01/2026")).toMatchObject({ ok: false, error: "There is no month 13. Use MM/DD/YYYY." });
    expect(parseTypedDate("00/10/2026")).toMatchObject({ ok: false });
    expect(parseTypedDate("10/00/2026")).toMatchObject({ ok: false });
  });

  it("treats empty and incomplete input as not a date", () => {
    expect(parseTypedDate("")).toMatchObject({ ok: false, empty: true });
    expect(parseTypedDate("   ")).toMatchObject({ ok: false, empty: true });
    for (const t of ["10/19", "10/19/2", "10/19/202", "10/", "abc", "10/19/20266", "2026-10"]) expect(parseTypedDate(t)).toMatchObject({ ok: false, empty: false });
  });

  it("keeps dates within the allowed range", () => {
    expect(parseTypedDate("12/31/1999")).toMatchObject({ ok: false, error: "Choose a date between 01/01/2000 and 12/31/2099." });
    expect(parseTypedDate("01/01/2100")).toMatchObject({ ok: false });
  });

  it("formats ISO dates for the field and ignores impossible ones", () => {
    expect(isoToTyped("2026-10-19")).toBe("10/19/2026");
    expect(isoToTyped("2026-02-30")).toBe("");
    expect(isoToTyped(null)).toBe("");
  });
});
