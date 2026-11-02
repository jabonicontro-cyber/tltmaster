/**
 * Customer health and cash forecast (B118, B119): signals from the company's own orders, invoices and payments. Pure
 * and deterministic; every figure is labelled an estimate where it is one. Nothing is sent or changed.
 */
import { daysBetween } from "@/lib/billing/invoices";
import { addDays } from "@/lib/dates";

export interface OrderPoint { customerId: string; customerName: string; orderDate: string; totalCents: number }
export interface PaidInvoice { customerId: string; issueDate: string; paidDate: string }
export interface OpenInvoice { id: string; number: string | null; customerId: string; customerName: string; issueDate: string; dueDate: string | null; balanceCents: number }

export interface CustomerSignal {
  customerId: string;
  customerName: string;
  kind: "ordering_less" | "paying_slower";
  detail: string;
  /** Monthly order value at stake (ordering) or the open balance (paying); for sorting. */
  weightCents: number;
}

/**
 * Ordering less: in the last 30 days the customer ordered under half of their usual month, where "usual" is the
 * average of the 3 months before that, and they usually order at least twice a month.
 */
export function orderingLess(orders: OrderPoint[], today: string): CustomerSignal[] {
  const recentFrom = addDays(today, -29);
  const baseFrom = addDays(today, -119);
  const by = new Map<string, { name: string; recent: number; recentCents: number; base: number; baseCents: number }>();
  for (const o of orders) {
    if (o.orderDate < baseFrom || o.orderDate > today) continue;
    const g = by.get(o.customerId) ?? { name: o.customerName, recent: 0, recentCents: 0, base: 0, baseCents: 0 };
    if (o.orderDate >= recentFrom) { g.recent += 1; g.recentCents += o.totalCents; } else { g.base += 1; g.baseCents += o.totalCents; }
    by.set(o.customerId, g);
  }
  const out: CustomerSignal[] = [];
  for (const [id, g] of by) {
    const usual = g.base / 3;
    const usualCents = g.baseCents / 3;
    if (usual < 2 || g.recent >= usual / 2) continue;
    out.push({
      customerId: id, customerName: g.name, kind: "ordering_less", weightCents: Math.round(usualCents - g.recentCents),
      detail: `${g.recent} order${g.recent === 1 ? "" : "s"} in the last 30 days; usually about ${Math.round(usual)} a month.`,
    });
  }
  return out.sort((a, b) => b.weightCents - a.weightCents);
}

/** Days from issue to payment for each paid invoice. */
const daysToPay = (p: PaidInvoice) => Math.max(0, daysBetween(p.issueDate, p.paidDate));

/** The customer's typical days to pay (median of their last up to 6 paid invoices), or null without history. */
export function typicalDaysToPay(paid: PaidInvoice[], customerId: string): number | null {
  const mine = paid.filter((p) => p.customerId === customerId).sort((a, b) => (a.paidDate < b.paidDate ? 1 : -1)).slice(0, 6).map(daysToPay).sort((a, b) => a - b);
  if (!mine.length) return null;
  const m = Math.floor(mine.length / 2);
  return mine.length % 2 ? mine[m] : Math.round((mine[m - 1] + mine[m]) / 2);
}

/** Paying slower: the last 2 payments took at least 10 days longer on average than the 4 before them. */
export function payingSlower(paid: PaidInvoice[], open: OpenInvoice[]): CustomerSignal[] {
  const ids = [...new Set(paid.map((p) => p.customerId))];
  const out: CustomerSignal[] = [];
  for (const id of ids) {
    const mine = paid.filter((p) => p.customerId === id).sort((a, b) => (a.paidDate < b.paidDate ? 1 : -1));
    if (mine.length < 4) continue;
    const avg = (xs: PaidInvoice[]) => xs.reduce((n, p) => n + daysToPay(p), 0) / xs.length;
    const recent = avg(mine.slice(0, 2));
    const before = avg(mine.slice(2, 6));
    if (recent - before < 10) continue;
    const owed = open.filter((o) => o.customerId === id).reduce((n, o) => n + o.balanceCents, 0);
    const name = open.find((o) => o.customerId === id)?.customerName ?? null;
    out.push({ customerId: id, customerName: name ?? "", kind: "paying_slower", weightCents: owed, detail: `Last 2 invoices paid in about ${Math.round(recent)} days; before that about ${Math.round(before)} days.` });
  }
  return out.sort((a, b) => b.weightCents - a.weightCents);
}

export interface ForecastWeek { from: string; to: string; cents: number; invoices: number }
export interface CashForecast { weeks: ForecastWeek[]; late: { cents: number; invoices: number }; beyond: { cents: number; invoices: number }; estimatedFromHistory: number; fromTerms: number; unknown: number }

/**
 * Expected collections over the next 4 weeks: each open invoice's expected payment date is its issue date plus the
 * customer's typical days to pay, or its due date without payment history. Already past that date = "late".
 */
export function cashForecast(open: OpenInvoice[], paid: PaidInvoice[], today: string): CashForecast {
  const weeks: ForecastWeek[] = [0, 1, 2, 3].map((w) => ({ from: addDays(today, w * 7), to: addDays(today, w * 7 + 6), cents: 0, invoices: 0 }));
  const late = { cents: 0, invoices: 0 };
  const beyond = { cents: 0, invoices: 0 };
  let estimatedFromHistory = 0, fromTerms = 0, unknown = 0;
  const typical = new Map<string, number | null>();
  for (const inv of open) {
    if (inv.balanceCents <= 0) continue;
    if (!typical.has(inv.customerId)) typical.set(inv.customerId, typicalDaysToPay(paid, inv.customerId));
    const t = typical.get(inv.customerId);
    const expected = t != null ? addDays(inv.issueDate, t) : inv.dueDate;
    if (t != null) estimatedFromHistory += 1; else if (inv.dueDate) fromTerms += 1;
    if (!expected) { unknown += 1; continue; }
    if (expected < today) { late.cents += inv.balanceCents; late.invoices += 1; continue; }
    const w = weeks.find((x) => expected >= x.from && expected <= x.to);
    if (w) { w.cents += inv.balanceCents; w.invoices += 1; } else { beyond.cents += inv.balanceCents; beyond.invoices += 1; }
  }
  return { weeks, late, beyond, estimatedFromHistory, fromTerms, unknown };
}
