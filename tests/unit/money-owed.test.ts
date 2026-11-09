import { describe, expect, it } from "vitest";
import { moneyOwed } from "@/lib/billing/invoices";
import { daysLateLabel } from "@/components/command-center/money-owed-tile";

// The Command Center's "Money owed" tile: open receivables, the overdue part and the oldest overdue invoice, by the
// same rules as Billing → Invoices (balanceCents, invoiceState).

const today = "2026-11-09";
const inv = (status: "draft" | "issued" | "void", total: number, due: string | null, paid: number[] = [], voided: number[] = []) => ({
  status, total_cents: total, due_date: due,
  payments: [...paid.map((a) => ({ amount_cents: a, voided_at: null })), ...voided.map((a) => ({ amount_cents: a, voided_at: "2026-11-01T00:00:00Z" }))],
});

describe("moneyOwed", () => {
  it("adds what is still owed on issued invoices and the overdue part, with the oldest days late", () => {
    const m = moneyOwed([
      inv("issued", 100_00, "2026-09-25"), // 45 days late
      inv("issued", 50_00, "2026-11-01", [20_00]), // 8 days late, partly paid: 30 owed
      inv("issued", 70_00, "2026-11-20"), // not due yet
      inv("issued", 40_00, "2026-10-01", [40_00]), // paid in full
    ], today);
    expect(m).toEqual({ openCents: 200_00, openCount: 3, overdueCents: 130_00, overdueCount: 2, oldestOverdueDays: 45, issuedCount: 4 });
  });

  it("ignores drafts and void invoices, and voided payments do not count as paid", () => {
    const m = moneyOwed([inv("draft", 999_00, "2026-01-01"), inv("void", 500_00, "2026-01-01"), inv("issued", 80_00, "2026-11-09", [], [80_00])], today);
    expect(m).toMatchObject({ openCents: 80_00, overdueCents: 0, oldestOverdueDays: null, issuedCount: 1 });
  });

  it("an invoice due today is not overdue", () => {
    expect(moneyOwed([inv("issued", 10_00, today)], today).overdueCount).toBe(0);
  });

  it("no invoices: nothing issued, so the tile says how invoices start instead of showing a zero", () => {
    expect(moneyOwed([], today)).toEqual({ openCents: 0, openCount: 0, overdueCents: 0, overdueCount: 0, oldestOverdueDays: null, issuedCount: 0 });
  });

  it("labels days late in plain words", () => {
    expect(daysLateLabel(1)).toBe("1 day late");
    expect(daysLateLabel(45)).toBe("45 days late");
  });
});
