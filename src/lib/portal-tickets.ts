// Customer portal Tickets page and its CSV download: the filter a customer chose, and the CSV of the filtered list.
// Pure, so the page and the download agree and both are tested without a database. The rows come only from
// public.portal_tickets (the customer's own live tickets); nothing here adds a figure that was not recorded.

import { isIsoDate } from "@/lib/dates";

export type PortalTicketRow = {
  id: string;
  order_id: string;
  order_number: string;
  number: string;
  delivered_at: string;
  /** The delivery day in the company's time zone. */
  delivered_on: string;
  quantity: number | string | null;
  unit: string;
  material: string | null;
  site: string;
  site_id: string | null;
  project: string;
  po: string;
  reference: string;
  confirmed: boolean;
};

export type PortalTicketList = { tickets: PortalTicketRow[]; has_more: boolean; limit: number; today: string };

export type TicketFilter = { from: string | null; to: string | null; site: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The filter from the address bar. Anything that is not a real date or one of the customer's own sites is ignored
 * (the database checks the site again); a range given backwards is turned around rather than refused. siteIds null:
 * the sites are not known here (the CSV download), so any well-formed id is passed on for the database to check.
 */
export function parseTicketFilter(sp: { from?: string | string[] | null; to?: string | string[] | null; site?: string | string[] | null }, siteIds: readonly string[] | null): TicketFilter {
  const one = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  let from: string | null = isIsoDate(one(sp.from)) ? one(sp.from) : null;
  let to: string | null = isIsoDate(one(sp.to)) ? one(sp.to) : null;
  if (from && to && to < from) [from, to] = [to, from];
  const s = one(sp.site).toLowerCase();
  const site = UUID.test(s) && (siteIds === null || siteIds.some((id) => id.toLowerCase() === s)) ? s : null;
  return { from, to, site };
}

/** The query string for this filter ("" when none), shared by the page's links and the CSV link. */
export function ticketFilterQuery(f: TicketFilter): string {
  const q = new URLSearchParams();
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.site) q.set("site", f.site);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Whether a filter is applied (for "Clear" and the empty state's wording). */
export const isFiltered = (f: TicketFilter) => Boolean(f.from || f.to || f.site);

/**
 * One CSV cell: quoted when needed, and a cell a spreadsheet would read as a formula (=, +, -, @, tab, return) starts
 * with an apostrophe, so a ticket reference typed in the field can never run as a formula on the customer's computer.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const TICKET_CSV_HEADER = ["Delivered", "Ticket", "Order", "Job site", "Project", "PO", "Material", "Quantity", "Unit", "Status", "Reference"];

/** A plain number for a spreadsheet ("12.5", never "12.50 Tons"); empty when not recorded. */
function plainQuantity(q: PortalTicketRow["quantity"]): string {
  if (q === null || q === undefined || q === "") return "";
  const n = Number(q);
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : "";
}

/** The filtered list as CSV (header first, newest first as shown), lines ending in CRLF as spreadsheets expect. */
export function ticketsCsv(rows: readonly PortalTicketRow[]): string {
  const lines = [TICKET_CSV_HEADER.map(csvCell).join(",")];
  for (const t of rows) {
    lines.push([
      t.delivered_on, t.number, t.order_number, t.site, t.project, t.po, t.material ?? "", plainQuantity(t.quantity), t.unit.replace(/_/g, " "),
      t.confirmed ? "Confirmed" : "Being checked", t.reference,
    ].map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The download's file name: "tickets-2026-11-01-to-2026-11-09.csv", "tickets-all.csv". */
export function ticketsCsvName(f: TicketFilter): string {
  const part = f.from && f.to ? `${f.from}-to-${f.to}` : f.from ? `from-${f.from}` : f.to ? `to-${f.to}` : "all";
  return `tickets-${part}${f.site ? "-site" : ""}.csv`;
}

/** Days with tickets, newest first: the page groups the list under each delivery day. */
export function groupByDay(rows: readonly PortalTicketRow[]): Array<{ day: string; tickets: PortalTicketRow[] }> {
  const out: Array<{ day: string; tickets: PortalTicketRow[] }> = [];
  for (const t of rows) {
    const last = out[out.length - 1];
    if (last && last.day === t.delivered_on) last.tickets.push(t);
    else out.push({ day: t.delivered_on, tickets: [t] });
  }
  return out;
}
