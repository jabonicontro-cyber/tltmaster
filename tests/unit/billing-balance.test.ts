import { describe, expect, it } from "vitest";
import { customerBalance, type BalanceInput } from "@/lib/billing/balance";
import { canPayNow } from "@/lib/billing/ticket-payments";

// The customer page's Balance block (office walkthrough 2026-11-09): what is owed, what is handed off but not
// invoiced, and delivered work not billed yet, each from its own records.

const empty: BalanceInput = { today: "2026-11-09", invoices: [], handoffs: [], delivered: [], ticketsOpenCents: null, creditCents: 0 };

describe("customerBalance", () => {
  it("is empty when nothing is owed or waiting", () => {
    expect(customerBalance(empty)).toMatchObject({ owedCents: 0, handedOffCents: 0, deliveredCents: 0, empty: true });
  });

  it("shows delivered work that is not invoiced yet (the Ironbridge case)", () => {
    const s = customerBalance({ ...empty, delivered: [{ value_cents: 39603, tickets_pending: 0 }] });
    expect(s).toMatchObject({ deliveredCents: 39603, deliveredOrders: 1, empty: false });
  });

  it("owed and overdue come from issued invoices less payments; drafts and voids owe nothing", () => {
    const s = customerBalance({
      ...empty,
      invoices: [
        { status: "issued", total_cents: 34800, due_date: "2026-10-25", payments: [] },
        { status: "issued", total_cents: 34800, due_date: "2026-12-09", payments: [{ amount_cents: 10000, voided_at: null }, { amount_cents: 500, voided_at: "2026-11-01" }] },
        { status: "void", total_cents: 99900, due_date: "2026-10-01", payments: [] },
      ],
    });
    expect(s.owedCents).toBe(34800 + 24800);
    expect(s.overdueCents).toBe(34800);
  });

  it("handed-off orders count until their invoice is issued (then they are in what is owed)", () => {
    const s = customerBalance({
      ...empty,
      handoffs: [{ total_cents: 40150, invoice_status: null }, { total_cents: 1000, invoice_status: "draft" }, { total_cents: 34800, invoice_status: "issued" }],
    });
    expect(s).toMatchObject({ handedOffCents: 41150, handedOffCount: 2, invoicedHandoffs: 1 });
  });

  it("counts tickets not accepted yet apart, never in the amount", () => {
    const s = customerBalance({ ...empty, delivered: [{ value_cents: 0, tickets_pending: 2 }, { value_cents: 1000, tickets_pending: 1 }, { value_cents: 0, tickets_pending: 0 }] });
    expect(s).toMatchObject({ deliveredCents: 1000, deliveredOrders: 2, ticketsPending: 3 });
  });

  it("credit alone is not empty", () => {
    expect(customerBalance({ ...empty, creditCents: 2500 }).empty).toBe(false);
  });
});

describe("canPayNow (the database rule for payments by ticket)", () => {
  const t = { open_cents: 5000, invoice_number: null as string | null, invoice_open_cents: null as number | null };
  it("with Taviron invoices, only tickets on an issued invoice", () => {
    expect(canPayNow(t, "taviron")).toBe(false);
    expect(canPayNow({ ...t, invoice_number: "INV-1002", invoice_open_cents: 5000 }, "taviron")).toBe(true);
    expect(canPayNow({ ...t, invoice_number: "INV-1002", invoice_open_cents: 0 }, "taviron")).toBe(false);
  });
  it("with QuickBooks, any billed ticket with something open", () => {
    expect(canPayNow(t, "quickbooks")).toBe(true);
    expect(canPayNow({ ...t, open_cents: 0 }, "quickbooks")).toBe(false);
  });
});
