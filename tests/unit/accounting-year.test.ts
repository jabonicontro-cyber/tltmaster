import { describe, expect, it } from "vitest";
import { defaultYear, invoicesCsv, paymentsCsv, yearSummary, type YearInvoice } from "@/lib/accounting/year";

const inv = (o: Partial<YearInvoice>): YearInvoice => ({ id: o.number ?? "x", number: "INV-1", status: "sent", customer_name: "Acme", order_number: "O-1", issue_date: "2025-03-01", due_date: "2025-03-31", total_cents: 10000, tax_cents: 0, payments: [], ...o });

describe("accountant year summary", () => {
  it("counts issued invoices and received payments in the year, leaves out void ones, ages what is open", () => {
    const s = yearSummary([
      inv({ number: "A", total_cents: 10000, tax_cents: 700, payments: [{ amount_cents: 4000, received_on: "2025-04-02", method: "check", reference: "101", voided_at: null }, { amount_cents: 6000, received_on: "2025-04-03", method: "check", reference: "102", voided_at: "2025-04-04" }] }),
      inv({ number: "B", issue_date: "2024-12-20", due_date: "2025-01-19", total_cents: 5000, payments: [{ amount_cents: 5000, received_on: "2025-01-10", method: "ach", reference: "", voided_at: null }] }),
      inv({ number: "C", status: "void", total_cents: 99999 }),
      inv({ number: "D", issue_date: null }),
      inv({ number: "E", issue_date: "2025-11-01", due_date: "2026-01-31", total_cents: 2500 }),
    ], 2025, "2026-02-15");
    expect(s.issued.map((i) => i.number)).toEqual(["A", "E"]);
    expect([s.invoicedCents, s.taxCents, s.receivedCents]).toEqual([12500, 700, 9000]);
    // A: 6000 open, due 2025-03-31 → over 90 days; E: 2500 open, 15 days late.
    expect(s.aging.map((a) => a.cents)).toEqual([0, 2500, 0, 0, 6000]);
    expect(s.outstandingCents).toBe(8500);
    expect(invoicesCsv(s).split("\r\n")[1]).toBe("A,2025-03-01,2025-03-31,Acme,O-1,sent,7.00,100.00,40.00,60.00");
    expect(paymentsCsv(s).split("\r\n").length).toBe(4); // header, two payments, trailing newline
  });

  it("neutralizes spreadsheet formulas in names", () => {
    const s = yearSummary([inv({ customer_name: "=HYPERLINK(1)" })], 2025, "2025-05-01");
    expect(invoicesCsv(s)).toContain("'=HYPERLINK(1)");
  });

  it("defaults to last year through April", () => {
    expect([defaultYear("2027-03-15"), defaultYear("2027-05-01")]).toEqual([2026, 2027]);
  });
});
