import { describe, expect, it } from "vitest";
import { partsSummaryText, summarizeParts } from "@/lib/maintenance/parts-summary";

// UX20: parts used per job (different parts from stock) and the part cost total (only for people who see costs).
describe("parts used per job", () => {
  const wo = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const moves = [
    { work_order_id: wo, part_id: "p1", kind: "used", quantity: -2, unit: "each" }, // two filters are two parts
    { work_order_id: wo, part_id: "oil", kind: "used", quantity: "-6.5", unit: "gal" }, // oil counts once...
    { work_order_id: wo, part_id: "oil", kind: "used", quantity: -2, unit: "Gal" }, // ...even when topped up again
    { work_order_id: wo, part_id: "p3", kind: "received" }, // not a use
    { work_order_id: "elsewhere", part_id: "p4", kind: "used" }, // not asked for
  ];
  const costs = [
    { work_order_id: wo, kind: "part", quantity: "2", unit_cost_cents: "1250" },
    { work_order_id: wo, kind: "part", quantity: 1.5, unit_cost_cents: 1000 },
    { work_order_id: wo, kind: "labor", quantity: 3, unit_cost_cents: 9000 }, // labor is not parts
  ];

  it("counts parts (countable by quantity, measured once) and adds up part cost lines", () => {
    const s = summarizeParts([wo, other], moves, costs);
    expect(s.get(wo)).toEqual({ parts: 3, costCents: 4000 });
    expect(s.get(other)).toEqual({ parts: 0, costCents: 0 });
    expect(partsSummaryText(s.get(wo))).toBe("3 parts used · $40.00 in parts");
    expect(partsSummaryText(s.get(other))).toBeNull();
  });

  it("never shows a cost to people who can't see costs", () => {
    const s = summarizeParts([wo], moves, null);
    expect(s.get(wo)).toEqual({ parts: 3, costCents: null });
    expect(partsSummaryText(s.get(wo))).toBe("3 parts used");
  });

  it("shows bought-in parts by their cost alone, and one part in the singular", () => {
    expect(partsSummaryText(summarizeParts([wo], [], costs).get(wo))).toBe("$40.00 in parts");
    expect(partsSummaryText({ parts: 1, costCents: null })).toBe("1 part used");
    expect(partsSummaryText(undefined)).toBeNull();
  });
});
