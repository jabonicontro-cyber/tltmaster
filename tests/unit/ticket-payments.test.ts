import { describe, expect, it } from "vitest";
import { applicationsOf, matchRemittance, matchTickets, parseRemittance, parseTicketList, payableCents, ticketKey, ticketState, type BilledTicket } from "@/lib/billing/ticket-payments";

const t = (n: string, open: number, extra: Partial<BilledTicket> = {}): BilledTicket => ({
  handoff_order_id: "h1", ticket_number: n, order_number: "ORD-1", billed_cents: 10_000, applied_cents: 10_000 - open, open_cents: open,
  delivered_at: null, reference: "", invoice_number: null, invoice_open_cents: null, qbo_numbers: [], ...extra,
});

describe("payments by ticket", () => {
  it("reads ticket numbers however they are written on a stub or an email", () => {
    expect(parseTicketList("TKT-1017, tkt-1018;#1019\n  1020  1020")).toEqual(["TKT-1017", "TKT-1018", "1019", "1020"]);
    expect(parseTicketList("   ")).toEqual([]);
  });

  it("matches full numbers, bare numbers and scale ticket numbers to open tickets only", () => {
    const tickets = [t("TKT-1017", 5000), t("TKT-1018", 0), t("TKT-1019", 7000, { reference: "SC-77" })];
    const r = matchTickets(["TKT-1017", "1018", "SC-77", "TKT-9999"], tickets);
    expect(r.matched.map((x) => x.ticket_number).sort()).toEqual(["TKT-1017", "TKT-1019"]);
    expect(r.notFound).toEqual(["1018", "TKT-9999"]); // 1018 is already paid
  });

  it("knows paid, part paid and open, and sends only real amounts", () => {
    expect(ticketState(t("A", 0))).toBe("paid");
    expect(ticketState(t("A", 4000))).toBe("part");
    expect(ticketState({ billed_cents: 100, applied_cents: 0, open_cents: 100 })).toBe("open");
    // Paid on the invoice itself: nothing left to pay by ticket, and never more than the invoice still owes.
    expect(ticketState(t("A", 4000, { invoice_open_cents: 0 }))).toBe("invoice");
    expect(payableCents(t("A", 4000, { invoice_open_cents: 2500 }))).toBe(2500);
    expect(payableCents(t("A", 4000))).toBe(4000);
    expect(matchTickets(["A"], [t("A", 4000, { invoice_open_cents: 0 })]).notFound).toEqual(["A"]);
    const tickets = [t("A", 5000), t("B", 3000)];
    expect(applicationsOf({ [ticketKey(tickets[0])]: 2500, [ticketKey(tickets[1])]: 0 }, tickets)).toEqual([{ handoff_order_id: "h1", ticket_number: "A", amount_cents: 2500 }]);
  });

  it("reads a remittance file with headers, in any column order, skipping totals and credits", () => {
    const csv = "Invoice,Ticket #,Date,Amount Paid\nINV-9,TKT-1017,11/02/2026,\"$1,250.00\"\nINV-9,1018,11/02/2026,300\nTotal,,,1550.00\nINV-9,TKT-1019,11/03/2026,(25.00)\n";
    const r = parseRemittance(csv);
    expect(r.hasAmounts).toBe(true);
    expect(r.lines.map((l) => [l.ticket, l.amount_cents])).toEqual([["TKT-1017", 125_000], ["1018", 30_000], ["TKT-1019", null]]);
  });

  it("reads rows copied from a spreadsheet without headers, and ticket-only lists", () => {
    const pasted = "TKT-1017\t11/02/2026\t$1,250.00\nTKT-1018\t11/02/2026\t$300.00";
    expect(parseRemittance(pasted).lines.map((l) => [l.ticket, l.amount_cents])).toEqual([["TKT-1017", 125_000], ["TKT-1018", 30_000]]);
    const list = parseRemittance("TKT-1017\nTKT-1018");
    expect(list.hasAmounts).toBe(false);
    expect(list.lines.map((l) => l.ticket)).toEqual(["TKT-1017", "TKT-1018"]);
  });

  it("matches remittance lines to open tickets, adds repeated lines, and flags amounts over what is open", () => {
    const tickets = [t("TKT-1017", 5000), t("TKT-1018", 3000, { handoff_order_id: "h2" }), t("TKT-1020", 0)];
    const m = matchRemittance([
      { ticket: "TKT-1017", amount_cents: 2000, row: 2 }, { ticket: "1017", amount_cents: 1000, row: 3 },
      { ticket: "TKT-1018", amount_cents: 4000, row: 4 }, { ticket: "TKT-1020", amount_cents: 500, row: 5 }, { ticket: "NOPE-1", amount_cents: 1, row: 6 },
    ], tickets);
    expect(m.selected).toEqual({ [ticketKey(tickets[0])]: 3000, [ticketKey(tickets[1])]: 4000 });
    expect(m.over).toEqual(["TKT-1018"]);
    expect(m.notFound.map((l) => l.ticket)).toEqual(["TKT-1020", "NOPE-1"]); // 1020 is already paid
  });
});

