import { describe, expect, it } from "vitest";
import { formatUnitQuantity, unitSingular, unitWord } from "@/lib/units";

describe("unitWord", () => {
  it("matches the number and is lowercase, from a code, a label or a short form", () => {
    expect(unitWord("Loads", 1)).toBe("load");
    expect(unitWord("load", 24)).toBe("loads");
    expect(unitWord("Miles", 60)).toBe("miles");
    expect(unitWord("mile", 1)).toBe("mile");
    expect(unitWord("cu_yd", 2)).toBe("cubic yards");
    expect(unitWord("Cubic yards", 1)).toBe("cubic yard");
    expect(unitWord("cubic_yards", 3)).toBe("cubic yards");
    expect(unitWord("Tons", 14.1)).toBe("tons");
    expect(unitWord("hr", 1)).toBe("hour");
    expect(unitWord("Each", 5)).toBe("each");
    expect(unitWord("each", 1)).toBe("each");
  });

  it("zero and fractions are plural; one is singular", () => {
    expect(unitWord("Loads", 0)).toBe("loads");
    expect(unitWord("Tons", 0.5)).toBe("tons");
    expect(unitWord("Tons", "1")).toBe("ton");
    expect(unitWord("Tons", "1.000")).toBe("ton");
  });

  it("handles a company's own units without mangling them", () => {
    expect(unitWord("Pallets", 1)).toBe("pallet");
    expect(unitWord("Pallets", 3)).toBe("pallets");
    expect(unitWord("Boxes", 1)).toBe("box");
    expect(unitWord("Boxes", 2)).toBe("boxes");
    expect(unitWord("Batteries", 1)).toBe("battery");
    expect(unitWord("Bag", 4)).toBe("bags");
    expect(unitWord("Gross", 2)).toBe("gross");
    expect(unitWord("CY", 3)).toBe("CY");
  });

  it("is empty without a unit", () => {
    expect(unitWord("", 2)).toBe("");
    expect(unitWord(null, 2)).toBe("");
    expect(unitWord(undefined, 1)).toBe("");
  });
});

describe("formatUnitQuantity", () => {
  it("reads the walkthrough cases correctly", () => {
    expect(formatUnitQuantity(1, "Loads")).toBe("1 load");
    expect(formatUnitQuantity(24, "load")).toBe("24 loads");
    expect(formatUnitQuantity(60, "Miles")).toBe("60 miles");
    expect(formatUnitQuantity("1", "loads")).toBe("1 load");
  });

  it("formats the number with grouping and up to three decimals", () => {
    expect(formatUnitQuantity(1250, "cu_yd")).toBe("1,250 cubic yards");
    expect(formatUnitQuantity("21.745", "Tons")).toBe("21.745 tons");
    expect(formatUnitQuantity(22.1, "Tons")).toBe("22.1 tons");
    expect(formatUnitQuantity("12.000", "ton")).toBe("12 tons");
  });

  it("is honest about missing data", () => {
    expect(formatUnitQuantity(null, "Tons")).toBe("");
    expect(formatUnitQuantity(undefined, "Tons")).toBe("");
    expect(formatUnitQuantity("", "Tons")).toBe("");
    expect(formatUnitQuantity("abc", "Tons")).toBe("");
    expect(formatUnitQuantity(7)).toBe("7");
    expect(formatUnitQuantity(0, "Loads")).toBe("0 loads");
  });
});

describe("unitSingular (unchanged)", () => {
  it("still gives the per-unit word", () => {
    expect(unitSingular("Loads", "load")).toBe("load");
    expect(unitSingular("Cubic yards", "cu yd")).toBe("cubic yard");
  });
});
