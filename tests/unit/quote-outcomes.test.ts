import { describe, expect, it } from "vitest";
import { bandFor, median, quoteOutcomes, type DecidedQuote } from "@/lib/quotes/outcomes";

// Quote win/loss (B95): counted only from decided quotes; rates hidden below three decided; medians need two quotes.

const q = (over: Partial<DecidedQuote>): DecidedQuote => ({
  id: Math.random().toString(36), number: "Q-1", outcome: "won", status: "accepted", customer: "Acme", decidedOn: "2026-10-20",
  firstSentOn: "2026-10-15", miles: 8, reason: "", totalCents: 100_00, materials: [{ name: "Gravel", unit: "ton", rateCents: 1000 }], ...over,
});

describe("quote outcomes", () => {
  it("counts wins and losses, values and days to a decision", () => {
    const r = quoteOutcomes([
      q({ outcome: "won", totalCents: 500_00 }),
      q({ outcome: "won", firstSentOn: "2026-10-18" }),
      q({ outcome: "lost", status: "declined", reason: "Too far", totalCents: 300_00, materials: [{ name: "Gravel", unit: "ton", rateCents: 1200 }] }),
      q({ outcome: "lost", status: "expired", firstSentOn: null, materials: [{ name: "Gravel", unit: "ton", rateCents: 1300 }] }),
    ]);
    expect([r.decided, r.won, r.lost]).toEqual([4, 2, 2]);
    expect(r.winRate).toBe(0.5);
    expect(r.wonValueCents).toBe(600_00);
    expect(r.lostValueCents).toBe(400_00);
    expect(r.medianDaysToDecision).toBe(5); // 5, 2 and 5 days
    const gravel = r.materials[0];
    expect([gravel.won, gravel.lost, gravel.medianWonCents, gravel.medianLostCents]).toEqual([2, 2, 1000, 1250]);
    expect(r.reasons).toEqual([{ number: "Q-1", customer: "Acme", reason: "Too far", decidedOn: "2026-10-20", status: "declined" }]);
  });

  it("hides a rate below three decided quotes and a median below two", () => {
    const r = quoteOutcomes([q({}), q({ outcome: "lost", status: "declined" })]);
    expect(r.winRate).toBeNull();
    expect(r.materials[0].medianWonCents).toBeNull();
  });

  it("groups by straight-line distance and counts quotes without a position", () => {
    const r = quoteOutcomes([q({ miles: 3 }), q({ miles: 30, outcome: "lost", status: "declined" }), q({ miles: null })]);
    expect(r.distance.map((g) => [g.key, g.decided])).toEqual([["0-10", 1], ["25-50", 1]]);
    expect(r.unlocated).toBe(1);
    expect(bandFor(10).key).toBe("10-25");
    expect(bandFor(120).key).toBe("50+");
  });

  it("counts a material once per quote, and nothing when there are no decided quotes", () => {
    const r = quoteOutcomes([q({ materials: [{ name: "Gravel", unit: "ton", rateCents: 1000 }, { name: "Gravel", unit: "ton", rateCents: 900 }] })]);
    expect(r.materials[0].decided).toBe(1);
    expect(quoteOutcomes([]).winRate).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
  });
});
