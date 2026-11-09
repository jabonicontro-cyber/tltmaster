import { describe, expect, it } from "vitest";
import { applicationsOf, matchTickets, parseTicketList, payableCents, ticketKey, ticketState, type BilledTicket } from "@/lib/billing/ticket-payments";

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
});
