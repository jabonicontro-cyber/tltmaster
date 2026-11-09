// Payments by delivery ticket (TP1, migration 20261120009400). Pure helpers for the "Payments by ticket" screen: read
// the ticket numbers off a check stub, remittance or bank reference as typed or pasted, and match them to the
// customer's billed tickets. The database decides what can be applied; these only prepare the selection.

export interface BilledTicket {
  handoff_order_id: string;
  ticket_number: string;
  order_number: string;
  billed_cents: number;
  applied_cents: number;
  open_cents: number;
  delivered_at: string | null;
  reference: string;
  invoice_number: string | null;
  /** What is still unpaid on the ticket's issued Taviron invoice (null without one): a payment recorded on the invoice
   *  itself lowers it too, so a ticket is never offered for more than its invoice still owes. */
  invoice_open_cents: number | null;
  qbo_numbers: string[];
}

export interface TicketPaymentRow {
  id: string;
  amount_cents: number;
  received_on: string;
  method: string;
  reference: string;
  note: string;
  voided: boolean;
  void_reason: string;
  unapplied_cents: number;
  tickets: Array<{ ticket_number: string; amount_cents: number }>;
}

export interface TicketBalances {
  issuer: "taviron" | "quickbooks";
  tickets: BilledTicket[];
  payments: TicketPaymentRow[];
  unapplied_cents: number;
}

export const ticketKey = (t: Pick<BilledTicket, "handoff_order_id" | "ticket_number">) => `${t.handoff_order_id}|${t.ticket_number}`;

/** What can still be paid on a ticket: its open share, never more than its invoice still owes. */
export function payableCents(t: Pick<BilledTicket, "open_cents"> & { invoice_open_cents?: number | null }): number {
  const open = Math.max(0, t.open_cents);
  return t.invoice_open_cents === null || t.invoice_open_cents === undefined ? open : Math.max(0, Math.min(open, t.invoice_open_cents));
}

/** How a ticket stands: paid, part paid, open, or settled on its invoice (paid there, not by ticket). */
export function ticketState(t: Pick<BilledTicket, "billed_cents" | "applied_cents" | "open_cents"> & { invoice_open_cents?: number | null }): "paid" | "part" | "open" | "invoice" {
  if (t.open_cents <= 0) return "paid";
  if (payableCents(t) === 0) return "invoice";
  return t.applied_cents > 0 ? "part" : "open";
}

const normal = (s: string) => s.trim().toUpperCase().replace(/^#/, "");

/**
 * Ticket numbers as people write them on a stub or in an email: separated by commas, spaces, semicolons or new lines,
 * with or without a leading '#'. Also matches the number without its prefix ("1017" for "TKT-1017") and the
 * paper/scale ticket number recorded with the ticket.
 */
export function parseTicketList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map(normal).filter((s) => s.length > 0 && s.length <= 60))];
}

export function matchTickets(typed: string[], tickets: BilledTicket[]): { matched: BilledTicket[]; notFound: string[] } {
  const open = tickets.filter((t) => payableCents(t) > 0);
  const matched = new Map<string, BilledTicket>();
  const notFound: string[] = [];
  for (const raw of typed) {
    const hits = open.filter((t) => {
      const n = normal(t.ticket_number);
      const digits = n.replace(/^[A-Z]+-?/, "");
      return n === raw || digits === raw || (t.reference && normal(t.reference) === raw);
    });
    if (hits.length === 0) notFound.push(raw);
    for (const h of hits) matched.set(ticketKey(h), h);
  }
  return { matched: [...matched.values()], notFound };
}

/** The selection as the database expects it, leaving out empty or zero amounts. */
export function applicationsOf(selected: Record<string, number>, tickets: BilledTicket[]) {
  return tickets
    .filter((t) => (selected[ticketKey(t)] ?? 0) > 0)
    .map((t) => ({ handoff_order_id: t.handoff_order_id, ticket_number: t.ticket_number, amount_cents: selected[ticketKey(t)] }));
}
