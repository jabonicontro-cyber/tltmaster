// Owner decisions 2026-11-14 to 11-17, batch C (pure rules): who sees sales totals (SEC7), the history without totals,
// "overdue but never sent" (BL1), the invoicing question in Getting started (INV1), Order to Cash's Invoiced and Paid
// stages (O2C1) and the driver's "Mistake on my ticket" wording (TM1).
import { describe, expect, it } from "vitest";
import { overdueNeverSent } from "@/lib/billing/invoices";
import { gettingStartedItems } from "@/lib/getting-started";
import { lifecycle, STAGES, type OrderRow } from "@/lib/order-to-cash";
import { redactHistoryEntry } from "@/lib/orders/money-history";
import { canSeeSalesTotals, type Permission } from "@/lib/permissions";
import { applyPreview } from "@/lib/platform/preview";
import { mistakeError, mistakeSentMessage, mistakeSummary } from "@/lib/tickets/mistakes";

const access = (permissions: Permission[]) => ({ permissions });

describe("sales totals (SEC7)", () => {
  it("billing or pricing access sees totals; a dispatcher, mechanic or driver does not", () => {
    expect(canSeeSalesTotals(access(["billing.view"]))).toBe(true);
    expect(canSeeSalesTotals(access(["billing.manage"]))).toBe(true);
    expect(canSeeSalesTotals(access(["pricing.edit"]))).toBe(true);
    expect(canSeeSalesTotals(access(["pricing.override"]))).toBe(true);
    expect(canSeeSalesTotals(access(["orders.view", "orders.create", "quotes.view", "dispatch.edit"]))).toBe(false);
    expect(canSeeSalesTotals(access(["driver.portal"]))).toBe(false);
    expect(canSeeSalesTotals(null)).toBe(false);
  });

  it("a demo owner previewing Dispatcher sees no totals (the preview narrows)", () => {
    const owner = { userId: "u", companyId: "c", companyName: "Demo", email: "", fullName: "", role: "owner" as const, active: true, permissions: ["billing.view", "pricing.edit", "orders.view"] as Permission[] };
    const rp = [{ role: "dispatcher", permission: "orders.view" }, { role: "dispatcher", permission: "orders.create" }];
    expect(canSeeSalesTotals(owner)).toBe(true);
    expect(canSeeSalesTotals(applyPreview(owner, "dispatcher", rp))).toBe(false);
  });

  it("the history keeps every entry but takes the totals out of those that carry one", () => {
    const created = { action: "order.created", summary: "ORD-1038 created (direct order, draft): total 610.00", details: { total_cents: 61000, edit_seq: 1, changes: { total_cents: { from: 1, to: 2 }, site_id: { from: null, to: "x" } } } };
    const fromQuote = { action: "order.created_from_quote", summary: "ORD-1018 created from QTE-1014 (revision 1), total 1,977.60", details: {} };
    const status = { action: "order.status_changed", summary: "ORD-1038: confirmed → scheduled, total 5.00", details: { total_cents: 1 } };
    expect(redactHistoryEntry(created)).toEqual({ action: "order.created", summary: "ORD-1038 created (direct order, draft)", details: { edit_seq: 1, changes: { site_id: { from: null, to: "x" } } } });
    expect(redactHistoryEntry(fromQuote).summary).toBe("ORD-1018 created from QTE-1014 (revision 1)");
    // Entries that carry no total are never touched.
    expect(redactHistoryEntry(status)).toBe(status);
  });
});

describe("overdue but never sent (BL1)", () => {
  const inv = (o: Partial<{ status: "draft" | "issued" | "void"; due_date: string | null; sent_at: string | null; paid: number }> = {}) => ({
    id: "i", status: o.status ?? "issued", customer_id: "c", customer_name: "C", total_cents: 10000, due_date: o.due_date === undefined ? "2026-11-01" : o.due_date,
    sent_at: o.sent_at ?? null, payments: o.paid ? [{ amount_cents: o.paid, voided_at: null }] : [],
  });
  it("flags only issued, past due, unpaid invoices with no send recorded", () => {
    expect(overdueNeverSent(inv(), "2026-11-18")).toBe(true);
    expect(overdueNeverSent(inv({ sent_at: "2026-10-02T10:00:00Z" }), "2026-11-18")).toBe(false);
    expect(overdueNeverSent(inv({ due_date: "2026-11-30" }), "2026-11-18")).toBe(false);
    expect(overdueNeverSent(inv({ due_date: null }), "2026-11-18")).toBe(false);
    expect(overdueNeverSent(inv({ paid: 10000 }), "2026-11-18")).toBe(false);
    expect(overdueNeverSent(inv({ status: "draft" }), "2026-11-18")).toBe(false);
    expect(overdueNeverSent(inv({ status: "void" }), "2026-11-18")).toBe(false);
  });
});

describe("Getting started: who sends your invoices (INV1)", () => {
  const all = (p: Permission) => ["settings.manage", "billing.manage", "fleet.edit", "customers.edit", "orders.edit"].includes(p);
  it("asks early, for an owner who can answer, until answered", () => {
    const items = gettingStartedItems("owner", { companyPhone: true, invoicingChosen: false }, all);
    expect(items.map((i) => i.key).slice(0, 2)).toEqual(["phone", "invoicing"]);
    const q = items.find((i) => i.key === "invoicing")!;
    expect(q.label).toBe("Who sends your invoices: Taviron or QuickBooks?");
    expect(q.done).toBe(false);
    expect(q.href).toBe("/settings?tab=invoicing#issuer");
    expect(gettingStartedItems("owner", { invoicingChosen: true }, all).find((i) => i.key === "invoicing")?.done).toBe(true);
  });
  it("is left out when Billing is switched off (not asked) or the owner cannot change invoicing", () => {
    expect(gettingStartedItems("owner", {}, all).some((i) => i.key === "invoicing")).toBe(false);
    expect(gettingStartedItems("owner", { invoicingChosen: false }, (p) => p !== "billing.manage" && all(p)).some((i) => i.key === "invoicing")).toBe(false);
  });
});

describe("Order to Cash from delivery to payment (O2C1)", () => {
  const row = (o: Partial<OrderRow> = {}): OrderRow => ({
    order_id: "o", order_number: "ORD-1", status: "completed", customer_name: "C", project_name: null, scheduled_start: "2026-11-01", order_date: "2026-11-01",
    completed_at: "2026-11-02", total_cents: 100_00, loads_total: 1, loads_missing: 0, loads_not_due: 0, tickets_live: 1, tickets_pending: 0, exceptions_count: 0,
    readiness: "handed_off", fulfilled: true, fulfillment_gap: null, handed_off_at: "2026-11-03T10:00:00Z", changed_since_handoff: false, batch_number: "B-1", ...o,
  });
  const invoice = (o: Partial<NonNullable<OrderRow["invoice"]>> = {}) => ({ id: "i1", number: "INV-1", status: "issued" as const, paid: false, overdue: false, neverSent: false, ...o });
  it("adds Invoiced and Paid after Handed off", () => {
    expect(STAGES.slice(-3)).toEqual(["handed_off", "invoiced", "paid"]);
    expect(lifecycle(row({ invoice: invoice() }))).toMatchObject({ stage: "invoiced", attention: false, href: "/billing/invoices/i1" });
    expect(lifecycle(row({ invoice: invoice({ paid: true }) }))).toMatchObject({ stage: "paid", attention: false });
    expect(lifecycle(row({ invoice: invoice({ overdue: true }) }))).toMatchObject({ stage: "invoiced", attention: true, owner: "billing" });
    expect(lifecycle(row({ invoice: invoice({ overdue: true, neverSent: true }) }))).toMatchObject({ stage: "invoiced", attention: true, next: "Send it now or mark it as sent" });
    expect(lifecycle(row({ invoice: invoice({ status: "draft" }) }))).toMatchObject({ stage: "handed_off", attention: true, next: "Issue the invoice" });
  });
  it("ends at Handed off without a Taviron invoice (QuickBooks), and a changed handoff still needs a look", () => {
    expect(lifecycle(row())).toMatchObject({ stage: "handed_off", attention: false });
    expect(lifecycle(row({ changed_since_handoff: true, invoice: invoice() }))).toMatchObject({ stage: "handed_off", attention: true });
  });
});

describe("Mistake on my ticket (TM1)", () => {
  it("needs a choice and either the right value or a note", () => {
    expect(mistakeError("", "1", "")).toBe("Choose what is wrong.");
    expect(mistakeError("quantity", "", "")).toMatch(/paper ticket/);
    expect(mistakeError("other", "", "")).toMatch(/note/);
    expect(mistakeError("quantity", "22.5", "")).toBeNull();
    expect(mistakeError("other", "", "Wrong site")).toBeNull();
  });
  it("reads plainly for the office and the driver", () => {
    expect(mistakeSummary("quantity", "22.5")).toBe("Quantity should be 22.5");
    expect(mistakeSummary("ticket_number", "")).toBe("Ticket number is wrong");
    expect(mistakeSummary("other", "Wrong job site")).toBe("Something else: Wrong job site");
    expect(mistakeSentMessage("TKT-1", "none")).toBe("Mistake on ticket TKT-1 sent to the office. They check it and correct the ticket.");
    expect(mistakeSentMessage("TKT-1", "failed")).toMatch(/show the paper ticket/);
  });
});

describe("missing amounts stay missing (review 2026-11-18)", () => {
  it("customer balance: an order whose value could not be read is counted apart, not as zero", async () => {
    const { customerBalance } = await import("@/lib/billing/balance");
    const s = customerBalance({ today: "2026-11-18", invoices: [], handoffs: [], delivered: [{ value_cents: null, tickets_pending: 0 }, { value_cents: 1000, tickets_pending: 0 }], ticketsOpenCents: null, creditCents: 0 });
    expect(s).toMatchObject({ deliveredCents: 1000, deliveredOrders: 2, deliveredUnknown: 1, empty: false });
  });
  it("Order to Cash: a stage's value is not available when any order's total could not be read", async () => {
    const { summarize } = await import("@/lib/order-to-cash");
    const base = { order_number: "O", status: "completed", customer_name: null, project_name: null, scheduled_start: "2026-11-01", order_date: "2026-11-01", completed_at: null, loads_total: 1, loads_missing: 0, loads_not_due: 0, tickets_live: 1, tickets_pending: 0, exceptions_count: 0, readiness: "ready" as const, fulfilled: true, fulfillment_gap: null, handed_off_at: null, changed_since_handoff: false, batch_number: null };
    const ready = (rows: Array<{ id: string; total: number | null }>) => summarize(rows.map((r) => ({ ...base, order_id: r.id, total_cents: r.total }))).find((x) => x.stage === "ready")!;
    expect(ready([{ id: "a", total: 100 }, { id: "b", total: 50 }]).cents).toBe(150);
    expect(ready([{ id: "a", total: 100 }, { id: "b", total: null }]).cents).toBeNull();
  });
  it("quote outcomes: won and lost values are not available rather than summed as zero", async () => {
    const { quoteOutcomes } = await import("@/lib/quotes/outcomes");
    const q = (outcome: "won" | "lost", totalCents: number | null) => ({ id: `${outcome}${totalCents}`, number: "Q", outcome, status: outcome === "won" ? "accepted" : "declined", customer: "C", decidedOn: "2026-11-01", firstSentOn: null, miles: null, reason: "", totalCents, materials: [] });
    expect(quoteOutcomes([q("won", 100), q("lost", 50)])).toMatchObject({ wonValueCents: 100, lostValueCents: 50 });
    expect(quoteOutcomes([q("won", null), q("lost", 50)])).toMatchObject({ wonValueCents: null, lostValueCents: 50 });
  });
  it("ordering less: without order values the signal counts orders and shows no dollar figure", async () => {
    const { orderingLess } = await import("@/lib/insights/customers");
    const pts = ["2026-07-25", "2026-07-26", "2026-08-10", "2026-08-11", "2026-09-10", "2026-09-11", "2026-09-12"].map((d) => ({ customerId: "A", customerName: "A", orderDate: d, totalCents: null }));
    const s = orderingLess(pts, "2026-11-18");
    expect(s).toHaveLength(1);
    expect(s[0].weightCents).toBeNull();
  });
});
