import type { HandoffSnapshot } from "@/lib/billing/rules";

// QuickBooks Online mapping (master plan B82): pure functions that turn a frozen billing-handoff snapshot into the
// invoice QuickBooks receives, so the payload is the same every time it is built and can be tested without Intuit.

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_MINOR_VERSION = "75";

export function qboApiBase(environment: "sandbox" | "production") {
  return environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com";
}

/** A string literal for a QuickBooks query ('…' with quotes and backslashes escaped). */
export function qboLiteral(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** QuickBooks DocNumber: at most 21 characters. The order number is used so both systems show the same reference. */
export function qboDocNumber(orderNumber: string) {
  return orderNumber.trim().slice(0, 21);
}

/** QuickBooks DisplayName: at most 500 characters and no colon (QuickBooks rejects ':' in names). */
export function qboDisplayName(name: string) {
  return name.replace(/:/g, "-").trim().slice(0, 500);
}

const dollars = (cents: number) => Math.round(cents) / 100;

export interface QboInvoiceLine {
  DetailType: "SalesItemLineDetail" | "DiscountLineDetail";
  Amount: number;
  Description?: string;
  SalesItemLineDetail?: { ItemRef: { value: string }; Qty?: number; UnitPrice?: number; ServiceDate?: string };
  DiscountLineDetail?: { PercentBased: false };
}

export interface QboInvoice {
  CustomerRef: { value: string };
  DocNumber: string;
  TxnDate?: string;
  Line: QboInvoiceLine[];
  PrivateNote: string;
}

/**
 * The invoice for one handed-off order. Every charge line becomes a line on the company's chosen product/service item,
 * with the line's own description and amount; quantity and rate are included only when they multiply exactly to the
 * amount (QuickBooks refuses lines where they do not). Discounts become one discount line (QuickBooks allows one).
 * Tax is left to QuickBooks' own tax setup; the totals are compared after the send and a difference is reported.
 */
export function buildQboInvoice(snapshot: HandoffSnapshot, refs: { customerId: string; itemId: string }, batchNumber: string): QboInvoice {
  const lines: QboInvoiceLine[] = [];
  for (const l of [...snapshot.lines].sort((a, b) => a.line_no - b.line_no)) {
    if (l.kind === "discount" || !l.amount_cents) continue;
    const qty = l.quantity === null || l.quantity === "" ? null : Number(l.quantity);
    const rate = l.unit_rate_cents === null ? null : l.unit_rate_cents / 100;
    const exact = qty !== null && rate !== null && Number.isFinite(qty) && Math.round(qty * rate * 100) === l.amount_cents;
    lines.push({
      DetailType: "SalesItemLineDetail",
      Amount: dollars(l.amount_cents),
      Description: [l.description, l.unit_code && qty !== null ? `${qty} ${l.unit_code}` : ""].filter(Boolean).join(" · ").slice(0, 4000),
      SalesItemLineDetail: { ItemRef: { value: refs.itemId }, ...(exact ? { Qty: qty!, UnitPrice: rate! } : {}), ...(snapshot.order.service_start ? { ServiceDate: snapshot.order.service_start } : {}) },
    });
  }
  if (snapshot.order.discount_cents > 0) {
    lines.push({ DetailType: "DiscountLineDetail", Amount: dollars(snapshot.order.discount_cents), DiscountLineDetail: { PercentBased: false } });
  }
  const tickets = snapshot.tickets.map((t) => t.ticket_number).filter(Boolean);
  return {
    CustomerRef: { value: refs.customerId },
    DocNumber: qboDocNumber(snapshot.order.order_number),
    ...(snapshot.order.service_end || snapshot.order.service_start ? { TxnDate: (snapshot.order.service_end ?? snapshot.order.service_start)! } : {}),
    Line: lines,
    PrivateNote: [`Taviron order ${snapshot.order.order_number}, billing batch ${batchNumber}`, snapshot.order.customer_po ? `PO ${snapshot.order.customer_po}` : "", tickets.length ? `Tickets ${tickets.slice(0, 40).join(", ")}${tickets.length > 40 ? "…" : ""}` : ""].filter(Boolean).join(". ").slice(0, 4000),
  };
}

/** Taviron's total before tax (what the invoice lines add up to) and with tax, in cents. */
export function snapshotTotals(snapshot: HandoffSnapshot) {
  return { beforeTax: snapshot.order.subtotal_cents - snapshot.order.discount_cents, total: snapshot.order.total_cents };
}

/** Plain words for a total that QuickBooks calculated differently (usually its own sales tax setup). */
export function totalDifference(tavironCents: number, qboCents: number | null): string | null {
  if (qboCents === null || tavironCents === qboCents) return null;
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  return `QuickBooks shows ${fmt(qboCents)}; Taviron's total is ${fmt(tavironCents)}. Check the tax on the invoice in QuickBooks.`;
}
