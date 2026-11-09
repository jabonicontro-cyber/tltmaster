import { parseAmountCents } from "@/lib/billing/invoices";
import { parseCsv } from "@/lib/platform/imports";

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

/**
 * Whether money can be applied to the ticket now. Mirrors private.apply_customer_payment (20261120009400): something
 * must be open on it, and where Taviron issues the invoices the ticket must be on an issued invoice first (until then
 * it is billed but not invoiced, and the database refuses the payment).
 */
export function canPayNow(t: Pick<BilledTicket, "open_cents" | "invoice_number"> & { invoice_open_cents?: number | null }, issuer: TicketBalances["issuer"]): boolean {
  return payableCents(t) > 0 && (issuer !== "taviron" || Boolean(t.invoice_number));
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

export interface RemittanceLine { ticket: string; amount_cents: number | null; row: number }

const TICKET_HEAD = /^(ticket|tkt|ticketno|ticketnumber|ticketnum|ticketid|scaleticket|deliveryticket|ticket#|tkt#|reference|ref|ticketref)$/;
const AMOUNT_HEAD = /^(amount|amt|paid|payment|amountpaid|paymentamount|total|net|netamount|applied|amountapplied)$/;
const head = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]/g, "");
const money = (s: string): number | null => {
  const t = s.trim();
  if (!t || /^\(.*\)$/.test(t) || t.startsWith("-")) return null; // credits and negatives are not payments
  return parseAmountCents(t);
};
const ticketLike = (s: string) => /^#?[A-Za-z]{0,6}-?\d{2,}$/.test(s.trim());

/**
 * A remittance as the customer sends it (TP1 slice 2): a CSV file, or rows copied from a spreadsheet or email, with a
 * ticket number and, usually, the amount paid on it. Finds the columns by their headers (Ticket, Ticket #, Reference;
 * Amount, Paid, Payment) or, without headers, by their contents. Lines without a ticket number are ignored; amounts
 * that cannot be read are left for a person to type.
 */
export function parseRemittance(text: string): { lines: RemittanceLine[]; hasAmounts: boolean } {
  const rows = parseCsv(text).map((r) => r.map((c) => c.trim()));
  if (rows.length === 0) return { lines: [], hasAmounts: false };
  let tCol = -1;
  let aCol = -1;
  let start = 0;
  const h = rows[0].map(head);
  if (h.some((x) => TICKET_HEAD.test(x))) {
    tCol = h.findIndex((x) => TICKET_HEAD.test(x));
    aCol = h.findIndex((x, i) => i !== tCol && AMOUNT_HEAD.test(x));
    start = 1;
  } else {
    // No header: the column that most often looks like a ticket number, and the one that most often reads as money.
    const width = Math.max(...rows.map((r) => r.length));
    const score = (f: (v: string) => boolean) => Array.from({ length: width }, (_, i) => rows.filter((r) => r[i] && f(r[i])).length);
    const t = score(ticketLike);
    tCol = t.indexOf(Math.max(...t));
    const a = score((v) => /[.$]/.test(v) && money(v) !== null).map((n, i) => (i === tCol ? -1 : n));
    aCol = Math.max(...a) > 0 ? a.indexOf(Math.max(...a)) : -1;
    if (Math.max(...t) === 0) return { lines: [], hasAmounts: false };
  }
  const lines: RemittanceLine[] = [];
  for (let i = start; i < rows.length; i++) {
    const ticket = (rows[i][tCol] ?? "").trim().toUpperCase().replace(/^#/, "");
    if (!ticket || ticket.length > 60 || !/\d/.test(ticket)) continue;
    lines.push({ ticket, amount_cents: aCol >= 0 ? money(rows[i][aCol] ?? "") : null, row: i + 1 });
  }
  return { lines, hasAmounts: lines.some((l) => l.amount_cents !== null) };
}

/**
 * Remittance lines matched to the customer's open tickets: what to tick and how much, the lines that matched no open
 * ticket, and lines whose amount is more than the ticket has open (kept as written so a person sees and decides).
 */
export function matchRemittance(lines: RemittanceLine[], tickets: BilledTicket[]) {
  const selected: Record<string, number | null> = {};
  const notFound: RemittanceLine[] = [];
  const over: string[] = [];
  for (const line of lines) {
    const { matched } = matchTickets([line.ticket], tickets);
    if (matched.length !== 1) {
      notFound.push(line);
      continue;
    }
    const t = matched[0];
    const k = ticketKey(t);
    const amount = line.amount_cents === null ? null : (selected[k] ?? 0) + line.amount_cents;
    selected[k] = amount;
    if (amount !== null && amount > payableCents(t)) over.push(t.ticket_number);
  }
  return { selected, notFound, over };
}
