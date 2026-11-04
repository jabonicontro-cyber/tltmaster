import { describe, expect, it } from "vitest";
import { agingBucket, balanceCents, invoiceState, parseAmountCents, receivablesAging, type InvoiceLite } from "@/lib/billing/invoices";

const inv = (o: Partial<InvoiceLite>): InvoiceLite => ({ id: "i", status: "issued", customer_id: "c1", customer_name: "Alder Paving", total_cents: 10000, due_date: "2026-10-31", payments: [], ...o });

describe("invoice balances and states", () => {
  it("owes the total less active payments, never on drafts or voids", () => {
    expect(balanceCents(inv({ payments: [{ amount_cents: 4000, voided_at: null }, { amount_cents: 5000, voided_at: "2026-10-01" }] }))).toBe(6000);
    expect(balanceCents(inv({ status: "draft" }))).toBe(0);
    expect(balanceCents(inv({ status: "void" }))).toBe(0);
  });
  it("reads open, overdue, partly paid and paid", () => {
    expect(invoiceState(inv({}), "2026-10-30")).toBe("open");
    expect(invoiceState(inv({}), "2026-11-01")).toBe("overdue");
    expect(invoiceState(inv({ payments: [{ amount_cents: 1, voided_at: null }] }), "2026-10-30")).toBe("partly_paid");
    expect(invoiceState(inv({ payments: [{ amount_cents: 10000, voided_at: null }] }), "2026-12-30")).toBe("paid");
  });
});

describe("receivables aging", () => {
  it("buckets by days past due", () => {
    expect(agingBucket("2026-11-01", "2026-11-01")).toBe("current");
    expect(agingBucket("2026-10-01", "2026-10-31")).toBe("1_30");
    expect(agingBucket("2026-09-01", "2026-10-31")).toBe("31_60");
    expect(agingBucket("2026-08-15", "2026-10-31")).toBe("61_90");
    expect(agingBucket("2026-06-01", "2026-10-31")).toBe("over_90");
  });
  it("adds up what each customer owes, largest first, skipping paid, draft and void invoices", () => {
    const { rows, totals } = receivablesAging([
      inv({ id: "a", due_date: "2026-11-15" }),
      inv({ id: "b", due_date: "2026-09-01", total_cents: 5000 }),
      inv({ id: "c", customer_id: "c2", customer_name: "Birch", total_cents: 30000, due_date: "2026-10-20" }),
      inv({ id: "d", status: "draft" }),
      inv({ id: "e", payments: [{ amount_cents: 10000, voided_at: null }] }),
    ], "2026-10-31");
    expect(rows.map((r) => [r.customer_name, r.total])).toEqual([["Birch", 30000], ["Alder Paving", 15000]]);
    expect(rows[1].buckets).toEqual({ current: 10000, "1_30": 0, "31_60": 5000, "61_90": 0, over_90: 0 });
    expect(totals.total).toBe(45000);
    expect(totals["1_30"]).toBe(30000);
  });
  it("reads typed amounts", () => {
    expect(parseAmountCents("$1,234.50")).toBe(123450);
    expect(parseAmountCents("0")).toBeNull();
    expect(parseAmountCents("12.345")).toBeNull();
  });
});

describe("invoices for several orders (UX10)", () => {
  it("says order or orders from the stored list of order numbers", async () => {
    const { ordersWord, defaultInvoiceEmail } = await import("@/lib/billing/invoices");
    expect(ordersWord("ORD-1001")).toBe("order");
    expect(ordersWord("ORD-1001, ORD-1002", true)).toBe("Orders");
    expect(defaultInvoiceEmail({ number: "INV-1", order_number: "ORD-1, ORD-2", bill_to: { name: "Acme" } }, "$10.00", "Dec 1", "Co").message).toContain("for orders ORD-1, ORD-2:");
  });
});
