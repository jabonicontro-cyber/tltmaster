import { describe, expect, it } from "vitest";
import { evaluateFormula, overlappingRules, selectRule, toCents, validateFormula, type PayRuleVersion, type TicketFacts } from "@/lib/payroll/formula";

const ok = (src: string, inputs: Record<string, string | null>) => {
  const r = evaluateFormula(src, inputs);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r;
};

describe("pay formula engine", () => {
  it("calculates per-ton pay exactly, rounding once to cents (half away from zero)", () => {
    expect(ok("tons * rate", { tons: "21.47", rate: "4.25" }).cents).toBe(BigInt(9125)); // 91.2475 → 91.25
    expect(ok("tons * rate", { tons: "0.1", rate: "0.2" }).cents).toBe(BigInt(2)); // 0.02 exactly (no float error)
    expect(ok("tons * rate", { tons: "10.005", rate: "1" }).cents).toBe(BigInt(1001)); // 10.005 → 10.01
    expect(toCents(-BigInt(15_000))).toBe(-BigInt(2)); // -0.015 → -0.02
  });

  it("supports other company models: per load, percentage, base plus, tiers", () => {
    expect(ok("loads * rate", { loads: "1", rate: "85" }).cents).toBe(BigInt(8500));
    expect(ok("billed_amount * 0.25", { billed_amount: "1234.56" }).cents).toBe(BigInt(30864));
    expect(ok("50 + tons * rate", { tons: "20", rate: "3" }).cents).toBe(BigInt(11000));
    expect(ok("if(tons > 20, tons * 4, tons * 3.5)", { tons: "22" }).cents).toBe(BigInt(8800));
    expect(ok("max(tons * rate, 60)", { tons: "10", rate: "4" }).cents).toBe(BigInt(6000)); // a minimum per ticket
    expect(ok("tons * rate * driver_share", { tons: "20", rate: "4", driver_share: "0.5" }).cents).toBe(BigInt(4000));
  });

  it("explains every result so a reviewer can follow it", () => {
    expect(ok("tons * rate", { tons: "21.47", rate: "4.25" }).breakdown).toBe("(tons (21.47) * rate (4.25)) = 91.2475 → 91.25");
  });

  it("never guesses: a missing input stops the calculation and is named", () => {
    expect(evaluateFormula("tons * rate", { tons: "20", rate: null })).toEqual({ ok: false, reason: "missing_input", missing: ["rate"] });
    expect(evaluateFormula("tons * rate", {})).toEqual({ ok: false, reason: "missing_input", missing: ["tons", "rate"] });
    expect(evaluateFormula("tons / rate", { tons: "1", rate: "0" })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("accepts only the listed inputs and operators — nothing is executed as code", () => {
    for (const bad of ["process.exit()", "tons; rate", "constructor", "tons ** 2", "price * tons", "tons * rate > 3", "if(tons, 1)", "", "1.1234567 * tons", "`x`", "tons[0]"]) {
      expect(validateFormula(bad).ok, bad).toBe(false);
    }
    expect(validateFormula("tons * rate")).toEqual({ ok: true, variables: ["tons", "rate"], usesBilling: false });
    expect(validateFormula("billed_amount * 0.2").usesBilling).toBe(true); // billing drives pay only when named
  });
});

describe("pay rule selection", () => {
  const base: Omit<PayRuleVersion, "id" | "scope"> = { rule_id: "r", name: "Per ton", status: "active", effective_from: "2026-01-01", effective_to: null, formula: "tons * rate", rate: "4", unit_code: "ton" };
  const ticket: TicketFacts = { delivered_on: "2026-10-01", unit_code: "ton", driver_id: "d1", customer_id: "c1", order_id: "o1", material_id: "m1", truck_id: "t1" };

  it("picks the most specific active rule in effect on the delivery date", () => {
    const general = { ...base, id: "g", scope: {} };
    const customer = { ...base, id: "c", rate: "4.5", scope: { customer_id: "c1" } };
    const other = { ...base, id: "o", scope: { customer_id: "c2" } };
    expect(selectRule([general, customer, other], ticket)).toMatchObject({ ok: true, rule: { id: "c" } });
    expect(selectRule([general], { ...ticket, unit_code: "load" })).toEqual({ ok: false, reason: "no_rule" });
  });

  it("uses effective dates so a rate change never rewrites earlier tickets", () => {
    const old = { ...base, id: "old", effective_to: "2026-09-30", scope: {} };
    const now = { ...base, id: "new", rate: "4.5", effective_from: "2026-10-01", scope: {} };
    expect(selectRule([old, now], { ...ticket, delivered_on: "2026-09-30" })).toMatchObject({ ok: true, rule: { id: "old" } });
    expect(selectRule([old, now], ticket)).toMatchObject({ ok: true, rule: { id: "new" } });
    expect(selectRule([{ ...now, status: "draft" }], ticket)).toEqual({ ok: false, reason: "no_rule" }); // drafts never pay
  });

  it("flags two equally specific rules as a conflict instead of choosing one, and finds overlaps before activation", () => {
    const a = { ...base, id: "a", scope: { customer_id: "c1" } };
    const b = { ...base, id: "b", scope: { driver_id: "d1" } };
    const r = selectRule([a, b], ticket);
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "conflict") expect(r.rules.map((x) => x.id)).toEqual(["a", "b"]);
    const same = { ...base, id: "a2", effective_from: "2026-06-01", scope: { customer_id: "c1" } };
    expect(overlappingRules([a, b], same).map((x) => x.id)).toEqual(["a"]);
    expect(overlappingRules([{ ...a, effective_to: "2026-05-31" }], same)).toEqual([]);
  });
});
