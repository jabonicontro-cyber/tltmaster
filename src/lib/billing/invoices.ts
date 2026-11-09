// Invoices and receivables (B99, migration 20261120004800): labels, what is owed and how late. Pure functions so the
// Invoices page, the invoice and Receivables agree, and they are tested without a database.

export type InvoiceStatus = "draft" | "issued" | "void";
export type PaymentMethod = "check" | "ach" | "card" | "cash" | "other";

export const PAYMENT_METHODS: Record<PaymentMethod, string> = { check: "Check", ach: "ACH / bank transfer", card: "Card", cash: "Cash", other: "Other" };

export interface InvoicePaymentLite { amount_cents: number; voided_at: string | null }
export interface InvoiceLite {
  id: string;
  status: InvoiceStatus;
  customer_id: string;
  customer_name: string;
  total_cents: number;
  due_date: string | null;
  payments: InvoicePaymentLite[];
}

/** Paid so far (active payments only). */
export const paidCents = (i: Pick<InvoiceLite, "payments">) => i.payments.filter((p) => !p.voided_at).reduce((n, p) => n + Number(p.amount_cents), 0);
/** Still owed; nothing is owed on a draft or a void invoice. */
export const balanceCents = (i: Pick<InvoiceLite, "status" | "total_cents" | "payments">) => (i.status === "issued" ? Math.max(0, Number(i.total_cents) - paidCents(i)) : 0);

/** The state a person sees: Draft, Open, Overdue, Partly paid, Paid or Void. */
export type InvoiceState = "draft" | "open" | "overdue" | "partly_paid" | "paid" | "void";
export function invoiceState(i: Pick<InvoiceLite, "status" | "total_cents" | "payments" | "due_date">, today: string): InvoiceState {
  if (i.status === "draft") return "draft";
  if (i.status === "void") return "void";
  const owed = balanceCents(i);
  if (owed === 0) return "paid";
  if (i.due_date && i.due_date < today) return "overdue";
  return paidCents(i) > 0 ? "partly_paid" : "open";
}
export const STATE_LABEL: Record<InvoiceState, { label: string; tone: "gray" | "blue" | "amber" | "green" | "critical-soft" }> = {
  draft: { label: "Draft", tone: "gray" },
  open: { label: "Open", tone: "blue" },
  partly_paid: { label: "Partly paid", tone: "amber" },
  overdue: { label: "Overdue", tone: "critical-soft" },
  paid: { label: "Paid", tone: "green" },
  void: { label: "Void", tone: "gray" },
};

/** Whole days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export const AGING_BUCKETS = ["current", "1_30", "31_60", "61_90", "over_90"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export const AGING_LABEL: Record<AgingBucket, string> = { current: "Not due yet", "1_30": "1–30 days late", "31_60": "31–60 days late", "61_90": "61–90 days late", over_90: "Over 90 days late" };

export function agingBucket(dueDate: string, today: string): AgingBucket {
  const late = daysBetween(dueDate, today);
  if (late <= 0) return "current";
  if (late <= 30) return "1_30";
  if (late <= 60) return "31_60";
  if (late <= 90) return "61_90";
  return "over_90";
}

export interface AgingRow { customer_id: string; customer_name: string; buckets: Record<AgingBucket, number>; total: number; oldestDue: string | null }

/** What each customer owes, by how late (issued invoices with a balance only), largest balance first. */
export function receivablesAging(invoices: InvoiceLite[], today: string): { rows: AgingRow[]; totals: Record<AgingBucket, number> & { total: number } } {
  const byCustomer = new Map<string, AgingRow>();
  const totals = { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 };
  for (const i of invoices) {
    const owed = balanceCents(i);
    if (!owed || !i.due_date) continue;
    const b = agingBucket(i.due_date, today);
    const row = byCustomer.get(i.customer_id) ?? { customer_id: i.customer_id, customer_name: i.customer_name, buckets: { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 }, total: 0, oldestDue: null };
    row.buckets[b] += owed;
    row.total += owed;
    if (!row.oldestDue || i.due_date < row.oldestDue) row.oldestDue = i.due_date;
    byCustomer.set(i.customer_id, row);
    totals[b] += owed;
    totals.total += owed;
  }
  return { rows: [...byCustomer.values()].sort((a, b) => b.total - a.total), totals };
}

export interface MoneyOwed {
  /** Still owed on issued invoices (after payments). */
  openCents: number;
  openCount: number;
  /** The part of it past the due date. */
  overdueCents: number;
  overdueCount: number;
  /** Days past due of the oldest overdue invoice; null when nothing is overdue. */
  oldestOverdueDays: number | null;
  /** Issued invoices of any state (paid ones included): none means invoicing has not started. */
  issuedCount: number;
}

/**
 * The Command Center's "Money owed" tile: what customers still owe on issued invoices, how much of it is past due and
 * how late the oldest one is. The same rules as the Invoices page (balanceCents, invoiceState); drafts and void
 * invoices owe nothing.
 */
export function moneyOwed(invoices: Array<Pick<InvoiceLite, "status" | "total_cents" | "payments" | "due_date">>, today: string): MoneyOwed {
  const out: MoneyOwed = { openCents: 0, openCount: 0, overdueCents: 0, overdueCount: 0, oldestOverdueDays: null, issuedCount: 0 };
  for (const i of invoices) {
    if (i.status !== "issued") continue;
    out.issuedCount += 1;
    const owed = balanceCents(i);
    if (!owed) continue;
    out.openCents += owed;
    out.openCount += 1;
    if (invoiceState(i, today) === "overdue" && i.due_date) {
      out.overdueCents += owed;
      out.overdueCount += 1;
      const late = daysBetween(i.due_date, today);
      if (out.oldestOverdueDays === null || late > out.oldestOverdueDays) out.oldestOverdueDays = late;
    }
  }
  return out;
}

/** "12.50" → 1250 (dollars and cents typed by a person); null when not a positive amount. */
export function parseAmountCents(v: string): number | null {
  const s = v.replace(/[$,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 ? cents : null;
}

/** The default email for an issued invoice (shown in the send form, editable). */
/** An invoice can bill several orders (UX10): their numbers are stored as one list ("ORD-1, ORD-2"). */
export const ordersWord = (orderNumber: string, capital = false) => (orderNumber.includes(", ") ? (capital ? "Orders" : "orders") : capital ? "Order" : "order");

export function defaultInvoiceEmail(inv: { number: string | null; order_number: string; bill_to: { name: string } }, total: string, due: string, companyName: string) {
  return {
    subject: `Invoice ${inv.number} from ${companyName}`,
    message: [`Hello ${inv.bill_to.name},`, "", `Attached is invoice ${inv.number} for ${ordersWord(inv.order_number)} ${inv.order_number}: ${total}, due ${due}.`, "", "Please reply to this email with any questions.", "", "Thank you,", companyName].join("\n"),
  };
}
