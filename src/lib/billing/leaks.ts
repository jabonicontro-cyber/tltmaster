/** Revenue leakage finder (B110): labels and totals for the findings computed by public.revenue_leaks. */

export type LeakKind = "not_billed" | "stuck" | "billed_short" | "billed_over" | "zero_rate" | "below_price_list" | "voided_invoice";

export interface Leak {
  key: string;
  kind: LeakKind;
  orderId: string;
  orderNumber: string;
  customerName: string;
  refId: string;
  refLabel: string;
  detail: string;
  amountCents: number | null;
  estimated: boolean;
  since: string | null;
  checkedReason: string | null;
  checkedAt: string | null;
}

export const LEAK_KINDS: Record<LeakKind, { label: string; hint: string; fix: string }> = {
  not_billed: { label: "Delivered, not billed", hint: "Ready to bill but never handed off.", fix: "Hand it off from Billing" },
  stuck: { label: "Billing held up", hint: "Delivered work waiting on tickets, review or exceptions.", fix: "Clear what blocks billing" },
  billed_short: { label: "Billed less than delivered", hint: "Handed off for fewer units than the accepted tickets show.", fix: "Revert the handoff and correct the order" },
  billed_over: { label: "Billed more than delivered", hint: "Handed off for more units than delivered; the customer may dispute it.", fix: "Revert the handoff and correct the order" },
  zero_rate: { label: "Delivered at $0", hint: "A delivered line has no price.", fix: "Set the line's price on the order" },
  below_price_list: { label: "Below the price list", hint: "Priced under the price-list rate when the order was made.", fix: "Check the order's price" },
  voided_invoice: { label: "Voided, not replaced", hint: "An invoice was voided and no new one was made.", fix: "Create a new invoice" },
};

export const LEAK_ORDER: LeakKind[] = ["not_billed", "billed_short", "stuck", "voided_invoice", "zero_rate", "below_price_list", "billed_over"];

/** Where the fix happens: the order (billing view), or the invoice for a voided invoice. */
export function leakHref(l: Pick<Leak, "kind" | "orderId" | "refId">): string {
  return l.kind === "voided_invoice" ? `/billing/invoices/${l.refId}` : `/orders/${l.orderId}`;
}

/** Possible missed revenue: positive amounts only (over-billing is a dispute risk, not missed revenue). */
export function missedTotal(leaks: Leak[]): number {
  return leaks.reduce((n, l) => n + (l.amountCents !== null && l.amountCents > 0 && l.kind !== "billed_over" ? l.amountCents : 0), 0);
}

export function byKind(leaks: Leak[]): Array<{ kind: LeakKind; count: number; cents: number }> {
  return LEAK_ORDER.map((kind) => {
    const of = leaks.filter((l) => l.kind === kind);
    return { kind, count: of.length, cents: of.reduce((n, l) => n + (l.amountCents ?? 0), 0) };
  }).filter((k) => k.count > 0);
}
