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

  it("collected counts every payment received in the year once, including payments by ticket not on an invoice yet", () => {
    // A payment by ticket of $73.45 applied $73.20 to invoice A (the invoice payment it created carries its id) and
    // left $0.25 as credit; a direct payment of $10 on B; a voided payment by ticket and one from another year.
    const s = yearSummary([
      inv({ number: "A", total_cents: 10000, payments: [{ amount_cents: 7320, received_on: "2025-06-02", method: "check", reference: "9", voided_at: null, customer_payment_id: "cp1" }] }),
      inv({ number: "B", total_cents: 5000, payments: [{ amount_cents: 1000, received_on: "2025-06-03", method: "ach", reference: "", voided_at: null, customer_payment_id: null }] }),
    ], 2025, "2025-07-01", [
      { id: "cp1", customer_name: "Acme", amount_cents: 7345, received_on: "2025-06-02", method: "check", reference: "9", voided_at: null },
      { id: "cp2", customer_name: "Acme", amount_cents: 5000, received_on: "2025-06-04", method: "check", reference: "10", voided_at: "2025-06-05" },
      { id: "cp3", customer_name: "Acme", amount_cents: 2000, received_on: "2024-12-30", method: "cash", reference: "", voided_at: null },
    ]);
    // Collected = $73.45 (whole payment by ticket, its invoice part not counted again) + $10.00 direct.
    expect(s.receivedCents).toBe(8345);
    expect(s.received).toHaveLength(2);
    expect(s.notOnInvoiceCents).toBe(25);
    expect(s.received.find((p) => p.source === "by_ticket")).toMatchObject({ invoices: "A", amount_cents: 7345, not_on_invoice_cents: 25 });
    // What is still owed follows the invoices only: A has $26.80 open, B $40.00.
    expect(s.outstandingCents).toBe(2680 + 4000);
    const lines = paymentsCsv(s).split("\r\n");
    expect(lines[0]).toBe("Received,Invoice,Customer,Method,Reference,Amount,Recorded,Not on an invoice yet");
    expect(lines[1]).toBe("2025-06-02,A,Acme,check,9,73.45,By ticket,0.25");
    expect(lines[2]).toBe("2025-06-03,B,Acme,ach,,10.00,On the invoice,0.00");
  });

  it("when payments by ticket could not be read, the invoice side still counts and the summary and file say what is missing", () => {
    const s = yearSummary([
      inv({ number: "A", total_cents: 10000, payments: [{ amount_cents: 7320, received_on: "2025-06-02", method: "check", reference: "9", voided_at: null, customer_payment_id: "cp1" }] }),
      inv({ number: "B", total_cents: 5000, payments: [{ amount_cents: 1000, received_on: "2025-06-03", method: "ach", reference: "", voided_at: null, customer_payment_id: null }] }),
    ], 2025, "2025-07-01", null);
    // The $73.20 that payment by ticket put on invoice A is counted from the invoice; the $0.25 credit cannot be known.
    expect(s.receivedCents).toBe(7320 + 1000);
    expect(s.ticketPaymentsMissing).toBe(true);
    const lines = paymentsCsv(s).split("\r\n");
    expect(lines.some((l) => l.startsWith("Payments by ticket could not be read"))).toBe(true);
    // Read normally: nothing is said missing.
    expect(yearSummary([], 2025, "2025-07-01", []).ticketPaymentsMissing).toBe(false);
  });

  it("neutralizes spreadsheet formulas in names", () => {
    const s = yearSummary([inv({ customer_name: "=HYPERLINK(1)" })], 2025, "2025-05-01");
    expect(invoicesCsv(s)).toContain("'=HYPERLINK(1)");
  });

  it("defaults to last year through April", () => {
    expect([defaultYear("2027-03-15"), defaultYear("2027-05-01")]).toEqual([2026, 2027]);
  });
});
