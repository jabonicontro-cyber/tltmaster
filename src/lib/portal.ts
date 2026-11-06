// Customer portal (B66): shapes returned by the portal_* database functions and customer-facing formatting.
// Everything a customer sees comes from these functions; nothing here invents a status, date or quantity.

export type PortalFeatures = { orders: boolean; quotes: boolean; documents: boolean; support: boolean; help: boolean; tracking: boolean; /** Customer self-booking (B115), from booking settings. */ booking?: boolean; /** Invoices and statements (UX5). */ invoices?: boolean };

export type PortalCompany = {
  name: string;
  slug: string;
  logo: string;
  color: string;
  welcome: string;
  contact_email: string;
  contact_phone: string;
  hours: string;
  /** The company's own time zone: every time in the portal is shown in it, never the server's. */
  timezone: string;
  is_demo: boolean;
  features: PortalFeatures;
};

export type PortalContext = PortalCompany & {
  customer: { name: string; number: string };
  email: string;
  sites: Array<{ id: string; label: string }>;
};

export type PortalOrderSummary = {
  id: string;
  number: string;
  status: string;
  status_label: string;
  requested_date: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  window_start: string | null;
  window_end: string | null;
  site: string;
  project: string;
  po: string;
  materials: string | null;
  loads_planned: number;
  tickets_confirmed: number;
  tickets_reported: number;
  quantity_confirmed: number;
  next_load: { date: string; start: string | null; end: string | null } | null;
  updated_at: string;
};

export type PortalOrder = PortalOrderSummary & {
  instructions: string;
  total_cents: number;
  /** delivered = live tickets in the line's unit (confirmed or being checked); tracked = billed from delivery tickets. */
  lines: Array<{ description: string; quantity: number | null; unit: string; tracked?: boolean; delivered?: number | null; confirmed?: number | null; remaining?: number | null }>;
  loads: Array<{ number: number; date: string; start: string | null; end: string | null; quantity: number | null; unit: string; canceled: boolean }>;
  tickets: Array<{ id: string; number: string; delivered_at: string; quantity: number; unit: string; confirmed: boolean }>;
  history: Array<{ label: string; at: string }>;
};

export type PortalQuoteRow = {
  id: string;
  number: string;
  status: "sent" | "accepted" | "declined" | "expired";
  sent_at: string | null;
  valid_until: string | null;
  project: string;
  total_cents: number;
  response: string | null;
};

export type PortalQuoteRequest = {
  id: string;
  material: string;
  quantity: number | null;
  unit: string;
  requested_date: string | null;
  status: "new" | "reviewing" | "quoted" | "declined" | "withdrawn";
  created_at: string;
  quote_number: string | null;
};

export type PortalQuote = {
  id: string;
  number: string;
  status: PortalQuoteRow["status"];
  sent_at: string | null;
  valid_until: string | null;
  quote_date: string | null;
  project: string;
  po: string;
  site: string;
  terms: string;
  instructions: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  total_cents: number;
  lines: Array<{ description: string; quantity: number | null; unit: string; amount_cents: number }>;
  can_respond: boolean;
  response: { response: "accept" | "decline"; status: "pending" | "confirmed" | "dismissed"; at: string; name: string } | null;
};

export type PortalSupportRow = { id: string; subject: string; status: "open" | "answered" | "closed"; created_at: string; updated_at: string; order_number: string | null };
export type PortalThread = PortalSupportRow & {
  /** Support center (B138); absent before that update is installed. */
  kind?: string; closed_at?: string | null; can_reopen?: boolean; ticket_number?: string | null; invoice_number?: string | null;
  messages: Array<{ id?: string; from: "customer" | "staff"; body: string; at: string; files?: Array<{ id: string; name: string; type: string }> }>;
};
export type PortalHelpArticle = { id: string; title: string; category: string; body: string; published_at: string | null };

export const QUOTE_STATUS_LABEL: Record<PortalQuoteRow["status"], string> = {
  sent: "Awaiting your answer",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

export const REQUEST_STATUS_LABEL: Record<PortalQuoteRequest["status"], string> = {
  new: "Received",
  reviewing: "Being priced",
  quoted: "Quoted",
  declined: "Not quoted",
  withdrawn: "Withdrawn",
};

export const SUPPORT_STATUS_LABEL: Record<PortalSupportRow["status"], string> = {
  open: "Waiting for a reply",
  answered: "Answered",
  closed: "Closed",
};

/** "Answered: accepted, waiting for confirmation" from the latest response "accept:pending". */
export function responseLabel(response: string | null): string | null {
  if (!response) return null;
  const [kind, state] = response.split(":");
  const verb = kind === "accept" ? "You accepted" : "You declined";
  if (state === "pending") return `${verb}: waiting for confirmation`;
  if (state === "confirmed") return `${verb}: confirmed`;
  return null;
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A calendar date (YYYY-MM-DD) as "Oct 21, 2026"; never shifted by the viewer's time zone. */
export function formatDay(d: string | null | undefined): string {
  if (!d) return "";
  const t = Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? "" : DATE.format(t);
}

/** "7:00 AM" from "07:00:00". */
export function formatTime(t: string | null | undefined): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  const hour = ((h + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The order's schedule as the customer should read it, or null when nothing is scheduled yet. */
/**
 * Whether an order belongs with past orders in the portal (UX5): completed or canceled, or — while the office has not
 * closed it yet — every scheduled day is over, nothing more is planned and every delivery is confirmed. Such an order
 * shows as "Delivered" instead of "Scheduled". On hold is always open.
 */
export function portalIsPast(o: Pick<PortalOrderSummary, "status" | "scheduled_start" | "scheduled_end" | "next_load" | "tickets_confirmed" | "tickets_reported">, today: string): boolean {
  if (o.status === "completed" || o.status === "canceled") return true;
  if (o.status === "on_hold") return false;
  const last = o.scheduled_end ?? o.scheduled_start;
  return Boolean(last && last < today && !o.next_load && o.tickets_confirmed > 0 && o.tickets_reported === 0);
}

/** The status shown to the customer: "Delivered" for an order that is finished but not closed yet (UX5). */
export function portalStatusLabel(o: Pick<PortalOrderSummary, "status" | "status_label" | "scheduled_start" | "scheduled_end" | "next_load" | "tickets_confirmed" | "tickets_reported">, today: string): string {
  return o.status !== "completed" && o.status !== "canceled" && portalIsPast(o, today) ? "Delivered" : o.status_label;
}

export function scheduleText(o: Pick<PortalOrderSummary, "scheduled_start" | "scheduled_end" | "window_start" | "window_end" | "requested_date">): string | null {
  if (o.scheduled_start) {
    const days = o.scheduled_end && o.scheduled_end !== o.scheduled_start ? `${formatDay(o.scheduled_start)} – ${formatDay(o.scheduled_end)}` : formatDay(o.scheduled_start);
    const window = o.window_start ? `, ${formatTime(o.window_start)}${o.window_end ? `–${formatTime(o.window_end)}` : ""}` : "";
    return days + window;
  }
  return null;
}

/** A moment (timestamp) in the company's time zone, e.g. "Oct 19, 1:05 PM". */
export function formatMoment(at: string | null | undefined, timeZone: string, withDate = true): string {
  if (!at) return "";
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "";
  const opts: Intl.DateTimeFormatOptions = withDate ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone } : { hour: "numeric", minute: "2-digit", timeZone };
  try {
    return new Intl.DateTimeFormat("en-US", opts).format(t);
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "America/Chicago" }).format(t);
  }
}

export function formatMoney(cents: number | null | undefined): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format((cents ?? 0) / 100);
}

export function formatQuantity(q: number | null | undefined, unit?: string): string {
  if (q === null || q === undefined) return "";
  const n = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(q));
  return unit ? `${n} ${unit}` : n;
}

/** Only an exact company slug (same rule as the database) reaches a portal function. */
export function isPortalSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(slug);
}

/** Invitation and tracking tokens are 64 lowercase hex characters. */
export function isPortalToken(token: string | null | undefined): token is string {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

export type PortalInvoiceRow = { id: string; number: string; issue_date: string; due_date: string; order_number: string | null; customer_po: string | null; project_name: string | null; total_cents: number; paid_cents: number; balance_cents: number; state: "open" | "overdue" | "paid" };
export type PortalStatement = { balance_cents: number; overdue_cents: number; current_cents: number; d1_30_cents: number; d31_60_cents: number; d61_90_cents: number; d90_plus_cents: number; open_count: number };
export type PortalInvoices = { enabled: false } | { enabled: true; as_of: string; invoices: PortalInvoiceRow[]; statement: PortalStatement };
export type PortalInvoice = {
  id: string; number: string; issue_date: string; due_date: string; terms_days: number | null; order_number: string | null; customer_po: string | null; project_name: string | null;
  service_start: string | null; service_end: string | null; bill_to: Record<string, unknown> | null; issued_by: Record<string, unknown> | null; footer: string | null;
  lines: Array<{ description: string; quantity: number | string | null; unit_code: string | null; unit_rate_cents: number | null; amount_cents: number }>;
  subtotal_cents: number; discount_cents: number; tax_cents: number; total_cents: number;
  payments: Array<{ received_on: string; amount_cents: number; method: string }>; paid_cents: number; balance_cents: number;
};

