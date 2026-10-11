import { describe, expect, it } from "vitest";
import { buildInvoiceDraft, type DraftOrderLine } from "@/lib/billing/invoice-draft";

const line = (o: Partial<DraftOrderLine> & Pick<DraftOrderLine, "id" | "line_no">): DraftOrderLine => ({
  kind: "material", calc_method: "per_unit", description: "Gravel", unit_code: "ton", quantity: "44", unit_rate_cents: 1000, percent_bp: null, taxable: true, amount_cents: 44000, ...o,
});

describe("invoice draft", () => {
  const lines = [
    line({ id: "gravel", line_no: 1 }),
    line({ id: "haul", line_no: 2, kind: "hauling", description: "Hauling per ton", unit_rate_cents: 500, taxable: false, amount_cents: 22000 }),
    line({ id: "fuel", line_no: 3, kind: "surcharge", calc_method: "percent_of_subtotal", description: "Fuel surcharge", unit_code: null, quantity: null, unit_rate_cents: null, percent_bp: 500, taxable: false, amount_cents: 3300 }),
  ];
  const tickets = [
    { order_line_id: "gravel", status: "accepted", quantity: "21.5", unit_code: "ton" },
    { order_line_id: "gravel", status: "accepted", quantity: "22", unit_code: "ton" },
    { order_line_id: "gravel", status: "voided", quantity: "30", unit_code: "ton" },
  ];

  it("prices delivered (accepted) quantities at the order's rates, and recomputes percentages and tax", () => {
    const d = buildInvoiceDraft({ lines, tickets, taxRateBp: 700, orderTotalCents: 72380, readiness: "ready" });
    expect(d.stage).toBe("draft");
    const [g, h, f] = d.lines;
    expect(g).toMatchObject({ basis: "delivered", quantity: 43.5, amountCents: 43500, warnings: [] });
    // The hauling line has no tickets of its own: ordered quantity, flagged for confirmation.
    expect(h).toMatchObject({ basis: "ordered_no_tickets", quantity: 44, amountCents: 22000 });
    expect(h.warnings[0]).toMatch(/Confirm it before invoicing/);
    // 5% of (435.00 + 220.00) = 32.75
    expect(f).toMatchObject({ basis: "percentage", quantity: null, amountCents: 3275 });
    expect(d.subtotalCents).toBe(68775);
    expect(d.taxCents).toBe(3045); // 7% of the taxable 435.00
    expect(d.totalCents).toBe(71820);
    expect(d.differenceCents).toBe(71820 - 72380);
    expect(d.needsConfirmation).toBe(1);
    expect(d.blockers).toEqual([]);
  });

  it("never counts unaccepted or other-unit tickets, and says so", () => {
    const d = buildInvoiceDraft({
      lines: [line({ id: "gravel", line_no: 1 })],
      tickets: [
        { order_line_id: "gravel", status: "accepted", quantity: "20", unit_code: "ton" },
        { order_line_id: "gravel", status: "needs_review", quantity: "22", unit_code: "ton" },
        { order_line_id: "gravel", status: "accepted", quantity: "1", unit_code: "load" },
      ],
      taxRateBp: 0,
      orderTotalCents: 44000,
      readiness: "needs_review",
    });
    expect(d.stage).toBe("preview");
    expect(d.lines[0].quantity).toBe(20);
    expect(d.lines[0].warnings).toEqual(["1 ticket is not accepted yet and is not counted.", "1 accepted ticket is in another unit and not counted."]);
    expect(d.blockers[0]).toMatch(/not ready for billing/);
  });

  it("keeps discounts as ordered and flags a zero rate", () => {
    const d = buildInvoiceDraft({
      lines: [line({ id: "g", line_no: 1, unit_rate_cents: 0 }), line({ id: "disc", line_no: 2, kind: "discount", description: "Discount", quantity: "1", unit_code: "each", unit_rate_cents: 2500, taxable: false })],
      tickets: [{ order_line_id: "g", status: "accepted", quantity: "10", unit_code: "ton" }],
      taxRateBp: 0,
      orderTotalCents: 0,
      readiness: null,
    });
    expect(d.lines[0].warnings).toContain("The line has no price (zero rate).");
    expect(d.lines[1]).toMatchObject({ basis: "ordered_fixed", amountCents: -2500 });
    expect(d.discountCents).toBe(2500);
    expect(d.blockers).toEqual(["Billing readiness could not be determined."]);
  });
});
