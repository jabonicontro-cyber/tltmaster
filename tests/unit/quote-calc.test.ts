import { describe, expect, it } from "vitest";
import { calculateQuote, type CalcLine } from "@/lib/quotes/calc";

const material = (qty: number, rate: number, taxable = true): CalcLine => ({
  kind: "material", calcMethod: "per_unit", quantityMilli: qty, rateCents: rate, percentBp: null, taxable,
});
const hauling = (qty: number, rate: number): CalcLine => ({
  kind: "hauling", calcMethod: "per_unit", quantityMilli: qty, rateCents: rate, percentBp: null, taxable: false,
});
const percent = (kind: CalcLine["kind"], bp: number, taxable = false): CalcLine => ({
  kind, calcMethod: "percent_of_subtotal", quantityMilli: null, rateCents: null, percentBp: bp, taxable,
});

describe("calculateQuote", () => {
  it("multiplies quantity by rate per line", () => {
    // 22.5 tons @ $14.25 = 320.625 → $320.63 (half away from zero)
    const t = calculateQuote([material(22500, 1425, false)], 0);
    expect(t.lineAmounts).toEqual([32063]);
    expect(t.totalCents).toBe(32063);
  });

  it("separates material and hauling and applies tax only to taxable lines", () => {
    const t = calculateQuote([material(20000, 1000), hauling(20000, 500)], 700);
    expect(t.subtotalCents).toBe(30000);
    expect(t.taxableCents).toBe(20000);
    expect(t.taxCents).toBe(1400);
    expect(t.totalCents).toBe(31400);
  });

  it("computes percentage surcharges on non-discount per-unit lines regardless of position", () => {
    const lines = [percent("surcharge", 500), material(10000, 1000, false), hauling(10000, 500)];
    const t = calculateQuote(lines, 0);
    expect(t.lineAmounts).toEqual([750, 10000, 5000]);
    expect(t.subtotalCents).toBe(15750);
  });

  it("treats discounts as negative and reports them separately", () => {
    const flat: CalcLine = { kind: "discount", calcMethod: "per_unit", quantityMilli: 1000, rateCents: 2500, percentBp: null, taxable: false };
    const t = calculateQuote([material(10000, 1000, false), flat, percent("discount", 1000)], 0);
    expect(t.lineAmounts).toEqual([10000, -2500, -1000]);
    expect(t.subtotalCents).toBe(10000);
    expect(t.discountCents).toBe(3500);
    expect(t.totalCents).toBe(6500);
  });

  it("reduces taxable amount by taxable discounts but never below zero", () => {
    const disc: CalcLine = { kind: "discount", calcMethod: "per_unit", quantityMilli: 1000, rateCents: 50000, percentBp: null, taxable: true };
    const t = calculateQuote([material(1000, 1000), disc], 700);
    expect(t.taxableCents).toBe(0);
    expect(t.taxCents).toBe(0);
    expect(t.totalCents).toBe(1000 - 50000);
  });

  it("rounds tax half away from zero", () => {
    // taxable 1007 cents * 7% = 70.49 → 70; 1050 * 7% = 73.5 → 74
    expect(calculateQuote([material(1000, 1007)], 700).taxCents).toBe(70);
    expect(calculateQuote([material(1000, 1050)], 700).taxCents).toBe(74);
  });

  it("handles large values exactly", () => {
    const t = calculateQuote([material(999999999, 100000000, false)], 0);
    expect(t.totalCents).toBe(99999999900000);
  });

  it("returns zeros for an empty quote", () => {
    expect(calculateQuote([], 700)).toEqual({
      lineAmounts: [], subtotalCents: 0, discountCents: 0, taxableCents: 0, taxCents: 0, totalCents: 0,
    });
  });
});
