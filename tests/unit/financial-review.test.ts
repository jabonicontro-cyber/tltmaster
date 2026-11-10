import { describe, expect, it } from "vitest";
import { billingBlockers, type BlockerInput } from "@/lib/billing/blockers";
import { readinessExplanation } from "@/lib/billing/rules";
import { correctableLines, priceCheckPending, priceCorrections, typedPriceLines } from "@/lib/orders/price-check";
import { parseMoneyToCents } from "@/lib/money";
import { canConfirmPrices, typedPriceChecked, type Permission } from "@/lib/permissions";
import { customerSchema, withoutLockedMoneyFields } from "@/lib/schemas/customer";

// Financial review fixes (2026-11-09; master plan §12 SEC4): "Price to be checked" (M1, owner 2026-11-10) on the order
// and billing pages, and who may set a customer's money fields (L4). The database checks the same
// (tests/db/financial-review.test.ts).

const perms = (...p: Permission[]) => ({ permissions: p });

describe("M1: price to be checked", () => {
  it("is pending from the request until someone confirms it", () => {
    expect(priceCheckPending({})).toBe(false);
    expect(priceCheckPending({ price_check_requested_at: "2026-11-10T08:00:00Z", price_checked_at: null })).toBe(true);
    expect(priceCheckPending({ price_check_requested_at: "2026-11-10T08:00:00Z", price_checked_at: "2026-11-10T09:00:00Z" })).toBe(false);
  });

  it("lists only the typed lines, in line order, with their price", () => {
    const lines = [
      { line_no: 3, description: "Fuel surcharge", calc_method: "percent_of_subtotal", unit_code: null, unit_rate_cents: null, percent_bp: 450, price_entered_by: "u1" },
      { line_no: 1, description: "Gravel #53", calc_method: "per_unit", unit_code: "ton", unit_label: "Ton", unit_rate_cents: 1000, percent_bp: null, price_entered_by: null },
      { line_no: 2, description: "Rush haul", calc_method: "per_unit", unit_code: "load", unit_label: "Load", unit_rate_cents: 9500, percent_bp: null, price_entered_by: "u1" },
    ];
    expect(typedPriceLines(lines)).toEqual(["Line 2, Rush haul: $95.00 per load", "Line 3, Fuel surcharge: 4.5% of the subtotal"]);
    expect(typedPriceLines([])).toEqual([]);
  });

  it("says the unit, not its plural label (\"per ton\", not \"per tons\")", () => {
    expect(typedPriceLines([{ line_no: 2, description: "Rush haul", calc_method: "per_unit", unit_code: "ton", unit_label: "Tons", unit_rate_cents: 650, percent_bp: null, price_entered_by: "u1" }]))
      .toEqual(["Line 2, Rush haul: $6.50 per ton"]);
  });

  it("billing corrects only typed per-unit lines, and sends only the prices that changed", () => {
    const lines = correctableLines([
      { id: "a", line_no: 1, description: "Gravel", calc_method: "per_unit", unit_code: "ton", unit_rate_cents: 1000, percent_bp: null, price_entered_by: null },
      { id: "b", line_no: 2, description: "Rush haul", calc_method: "per_unit", unit_code: "ton", unit_rate_cents: 9500, percent_bp: null, price_entered_by: "u1" },
      { id: "c", line_no: 3, description: "Fuel", calc_method: "percent_of_subtotal", unit_code: null, unit_rate_cents: null, percent_bp: 450, price_entered_by: "u1" },
      { id: "d", line_no: 4, description: "Tarping", calc_method: "per_unit", unit_code: "load", unit_rate_cents: 2500, percent_bp: null, price_entered_by: "u1" },
    ]);
    expect(lines).toEqual([
      { id: "b", label: "Line 2, Rush haul", unit: "ton", rateCents: 9500 },
      { id: "d", label: "Line 4, Tarping", unit: "load", rateCents: 2500 },
    ]);
    expect(priceCorrections(lines, { b: "95.00", d: "25" }, parseMoneyToCents)).toEqual([]);
    expect(priceCorrections(lines, { b: "88", d: "25.00" }, parseMoneyToCents)).toEqual([{ line_id: "b", unit_rate_cents: 8800 }]);
    expect(priceCorrections(lines, { b: "eighty" }, parseMoneyToCents)).toBeNull();
  });

  it("is confirmed by pricing.edit, pricing.override or billing.manage, and flags prices typed by everyone else who enters orders", () => {
    expect(canConfirmPrices(perms("pricing.edit"))).toBe(true);
    expect(canConfirmPrices(perms("pricing.override"))).toBe(true);
    expect(canConfirmPrices(perms("billing.manage"))).toBe(true);
    expect(canConfirmPrices(perms("orders.create", "orders.edit", "billing.view"))).toBe(false);
    expect(canConfirmPrices(null)).toBe(false);
    // The default dispatcher's typed prices are checked; the office's, and anyone who may decide prices, are not.
    expect(typedPriceChecked(perms("orders.create", "orders.schedule", "dispatch.edit"))).toBe(true);
    expect(typedPriceChecked(perms("orders.create", "orders.edit"))).toBe(false);
    expect(typedPriceChecked(perms("orders.create", "pricing.edit"))).toBe(false);
  });

  it("keeps the order out of billing with its own blocker and explanation, never as unacknowledged exceptions", () => {
    const o: BlockerInput = {
      readiness: "blocked", status: "completed", fulfilled: true, fulfillment_gap: null,
      loads_missing: 0, tickets_live: 1, tickets_pending: 0, exceptions_count: 1, acknowledgment_id: "ack-1", price_check_pending: true,
    };
    const b = billingBlockers(o);
    expect(b.map((x) => x.key)).toEqual(["price_check"]);
    expect(b[0]).toMatchObject({ title: "Price to be checked", actionable: true });
    expect(b[0].detail).toMatch(/not handed off or invoiced/);
    // With differences still to acknowledge too, both are listed.
    expect(billingBlockers({ ...o, acknowledgment_id: null }).map((x) => x.key)).toEqual(["price_check", "exceptions"]);
    const e = readinessExplanation("blocked", { ...o, loads_not_due: 0 });
    expect(e.why).toBe("A price typed without a price-list rate is to be checked.");
    expect(e.next).toBe("Confirm the typed price");
    // Without a price check, as before.
    expect(readinessExplanation("blocked", { ...o, loads_not_due: 0, price_check_pending: false }).next).toBe("Resolve the exceptions");
  });
});

describe("L4: a customer's money fields", () => {
  const form = customerSchema.parse({ name: "Lakeshore Paving (test)", customer_type: "commercial", price_list_id: "", payment_terms: "Net 30", tax_exempt: "on" });

  it("are left out of what is saved for people who may not set them", () => {
    const clerk = withoutLockedMoneyFields(form, { pricing: false, billing: false });
    expect(clerk).not.toHaveProperty("price_list_id");
    expect(clerk).not.toHaveProperty("tax_exempt");
    expect(clerk).not.toHaveProperty("payment_terms");
    expect(clerk).toMatchObject({ name: "Lakeshore Paving (test)" });
    expect(withoutLockedMoneyFields(form, { pricing: true, billing: false })).toMatchObject({ tax_exempt: true, price_list_id: null });
    expect(withoutLockedMoneyFields(form, { pricing: true, billing: false })).not.toHaveProperty("payment_terms");
    expect(withoutLockedMoneyFields(form, { pricing: false, billing: true })).toMatchObject({ payment_terms: "Net 30" });
    expect(withoutLockedMoneyFields(form, { pricing: true, billing: true })).toEqual(form);
  });
});
