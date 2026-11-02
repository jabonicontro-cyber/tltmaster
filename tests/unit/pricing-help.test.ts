import { describe, expect, it } from "vitest";
import type { DecidedQuote } from "@/lib/quotes/outcomes";
import { pricingHelp } from "@/lib/quotes/pricing-help";

let n = 0;
function q(outcome: "won" | "lost", rateCents: number, miles: number | null, name = "Base rock", unit = "ton"): DecidedQuote {
  n += 1;
  return { id: `q${n}`, number: `Q-${n}`, outcome, status: outcome === "won" ? "accepted" : "declined", customer: "C", decidedOn: "2026-10-01", firstSentOn: null, miles, reason: "", totalCents: 0, materials: [{ name, unit, rateCents }] };
}

describe("quote pricing help (B114)", () => {
  const history = [q("won", 1800, 5), q("won", 1900, 6), q("won", 2000, 8), q("lost", 2400, 7), q("lost", 2500, 9), q("won", 2600, 40), q("won", 2700, 45), q("won", 2800, 30)];

  it("uses quotes at a similar distance when there are enough, and suggests the typical winning rate", () => {
    const h = pricingHelp({ name: "Base rock", unit: "ton", rateCents: 1950, miles: 4 }, history);
    expect(h.basis).toBe("distance");
    expect(h.bandLabel).toBe("Under 10 miles");
    expect([h.won, h.lost]).toEqual([3, 2]);
    expect(h.medianWonCents).toBe(1900);
    expect(h.suggestedCents).toBe(1900);
    expect(h.verdict).toBe("in_line");
  });

  it("falls back to all distances when the band is thin", () => {
    const h = pricingHelp({ name: "Base rock", unit: "ton", rateCents: 2700, miles: 15 }, history);
    expect(h.basis).toBe("all");
    expect(h.won).toBe(6);
  });

  it("flags a rate at or above what lost quotes charged, and one below every win", () => {
    expect(pricingHelp({ name: "base rock", unit: "TON", rateCents: 2450, miles: 4 }, history).verdict).toBe("high");
    expect(pricingHelp({ name: "Base rock", unit: "ton", rateCents: 1500, miles: 4 }, history).verdict).toBe("low");
  });

  it("says there is not enough history instead of guessing", () => {
    const h = pricingHelp({ name: "Rip rap", unit: "ton", rateCents: 3000, miles: 4 }, [q("won", 3100, 4, "Rip rap")]);
    expect(h.verdict).toBe("no_history");
    expect(h.suggestedCents).toBeNull();
    expect(h.reason).toMatch(/Only 1 won quote/);
    expect(pricingHelp({ name: "Sand", unit: "ton", rateCents: null, miles: null }, history).reason).toBe("No won quotes for this item and unit yet.");
  });

  it("compares per-load lines with the measured cost per load and never suggests below it", () => {
    const loads = [q("won", 30000, 12, "Hauling", "load"), q("won", 32000, 14, "Hauling", "load")];
    const below = pricingHelp({ name: "Hauling", unit: "load", rateCents: 25000, miles: 12 }, loads, 28000);
    expect(below.verdict).toBe("below_cost");
    expect(below.costPerLoadCents).toBe(28000);
    expect(pricingHelp({ name: "Hauling", unit: "load", rateCents: 31000, miles: 12 }, loads, 35000).suggestedCents).toBe(35000);
    // Per-ton lines are never compared with a per-load cost.
    expect(pricingHelp({ name: "Base rock", unit: "ton", rateCents: 100, miles: 4 }, history, 28000).costPerLoadCents).toBeNull();
  });
});
