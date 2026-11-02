import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { cashForecast, orderingLess, payingSlower, typicalDaysToPay, type OpenInvoice, type OrderPoint, type PaidInvoice } from "@/lib/insights/customers";

const TODAY = "2026-11-02";
const ord = (c: string, daysAgo: number, cents = 100_000): OrderPoint => ({ customerId: c, customerName: `Customer ${c}`, orderDate: addDays(TODAY, -daysAgo), totalCents: cents });
const paid = (c: string, issueAgo: number, days: number): PaidInvoice => ({ customerId: c, issueDate: addDays(TODAY, -issueAgo), paidDate: addDays(TODAY, -issueAgo + days) });
const open = (id: string, c: string, issueAgo: number, cents: number, dueIn: number | null = 30): OpenInvoice => ({ id, number: id, customerId: c, customerName: `Customer ${c}`, issueDate: addDays(TODAY, -issueAgo), dueDate: dueIn === null ? null : addDays(TODAY, -issueAgo + dueIn), balanceCents: cents });

describe("customer health", () => {
  it("flags a regular customer whose orders dropped below half their usual month", () => {
    const orders = [...[35, 45, 55, 65, 75, 85, 95, 105, 115].map((d) => ord("A", d)), ord("A", 10), ...[40, 70, 100].map((d) => ord("B", d))];
    const s = orderingLess(orders, TODAY);
    expect(s.map((x) => x.customerId)).toEqual(["A"]); // B orders once a month: too few to judge
    expect(s[0].detail).toBe("1 order in the last 30 days; usually about 3 a month.");
    expect(orderingLess([...orders, ord("A", 5), ord("A", 2)], TODAY)).toEqual([]);
  });

  it("flags slower payment and estimates typical days to pay", () => {
    const history = [paid("A", 20, 45), paid("A", 60, 40), paid("A", 100, 20), paid("A", 140, 25), paid("A", 180, 22), paid("A", 220, 21)];
    const s = payingSlower(history, [open("I1", "A", 10, 500_000)]);
    expect(s[0]).toMatchObject({ customerId: "A", weightCents: 500_000 });
    expect(s[0].detail).toBe("Last 2 invoices paid in about 43 days; before that about 22 days.");
    expect(payingSlower(history.slice(0, 3), [])).toEqual([]);
    expect(typicalDaysToPay(history, "A")).toBe(24); // median of 20, 21, 22, 25, 40, 45
    expect(typicalDaysToPay(history, "Z")).toBeNull();
  });
});

describe("cash forecast", () => {
  it("places each open invoice by the customer's habit, else its due date", () => {
    const history = [paid("A", 60, 20), paid("A", 90, 20)];
    const f = cashForecast([
      open("I1", "A", 15, 100_000),         // issued 15 days ago + 20 typical = in 5 days: week 1
      open("I2", "A", 30, 50_000),          // expected 10 days ago: late
      open("I3", "B", 5, 70_000, 30),       // no history: due in 25 days: week 4
      open("I4", "B", 5, 30_000, 60),       // due in 55 days: beyond
      open("I5", "B", 5, 10_000, null),     // no terms, no history: unknown
    ], history, TODAY);
    expect(f.weeks.map((w) => w.cents)).toEqual([100_000, 0, 0, 70_000]);
    expect(f.late).toEqual({ cents: 50_000, invoices: 1 });
    expect(f.beyond).toEqual({ cents: 30_000, invoices: 1 });
    expect([f.estimatedFromHistory, f.fromTerms, f.unknown]).toEqual([2, 2, 1]);
  });
});
