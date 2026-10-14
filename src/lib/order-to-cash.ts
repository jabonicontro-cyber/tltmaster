// Order-to-Cash Control Center (B42, increment 1; owner authorization 2026-10-13). Read-only: it places each order on
// one lifecycle — scheduling, dispatch, delivery, tickets, billing review, ready to bill, handed off — from what the
// database already computes (billing_order_status: order status, fulfillment gap, tickets, readiness, handoff), and
// says what needs attention, why, which team acts next and where. It never changes an order and has no business rules
// of its own: the reasons and next steps come from src/lib/billing/rules.ts. Invoices and payments are not built
// (master plan §9 Q9, Q10, Q15) and are shown as such.

import { FULFILLMENT_GAP_LABELS, readinessExplanation, type FulfillmentGap, type Readiness } from "@/lib/billing/rules";

export const STAGES = ["scheduling", "dispatch", "delivery", "tickets", "review", "ready", "handed_off"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  scheduling: "Needs scheduling",
  dispatch: "Needs loads",
  delivery: "In delivery",
  tickets: "Tickets",
  review: "Billing review",
  ready: "Ready to bill",
  handed_off: "Handed off",
};

/** The team whose permission covers the next action (no individual is assigned here). */
export const OWNERS = { dispatch: "Dispatch", office: "Office (ticket review)", billing: "Billing", none: "No action" } as const;
export type Owner = keyof typeof OWNERS;

export interface OrderRow {
  order_id: string;
  order_number: string;
  status: string;
  customer_name: string | null;
  project_name: string | null;
  scheduled_start: string | null;
  order_date: string;
  completed_at: string | null;
  total_cents: number;
  loads_total: number;
  loads_missing: number;
  loads_not_due: number;
  tickets_live: number;
  tickets_pending: number;
  exceptions_count: number;
  readiness: Readiness;
  fulfilled: boolean;
  fulfillment_gap: FulfillmentGap | null;
  handed_off_at: string | null;
  changed_since_handoff: boolean;
  batch_number: string | null;
}

export interface Lifecycle {
  stage: Stage;
  /** Someone must act now (an order simply waiting for its loads to run does not). */
  attention: boolean;
  why: string;
  next: string;
  owner: Owner;
  href: string;
}

export function lifecycle(o: OrderRow): Lifecycle {
  const billing = `/billing/orders/${o.order_id}`;
  if (o.status === "confirmed" && !o.scheduled_start) {
    return { stage: "scheduling", attention: true, why: "Confirmed, but no delivery date is set.", next: "Schedule the order", owner: "dispatch", href: "/dispatch#needs-scheduling" };
  }
  if (o.readiness === "handed_off") {
    return o.changed_since_handoff
      ? { stage: "handed_off", attention: true, why: `Handed off in ${o.batch_number ?? "a batch"}, then the tickets or exceptions changed.`, next: "Check the changes; undo the handoff if the batch is wrong", owner: "billing", href: billing }
      : { stage: "handed_off", attention: false, why: `Handed off for billing${o.batch_number ? ` in ${o.batch_number}` : ""}.`, next: "Invoice in your accounting system", owner: "none", href: billing };
  }
  const r = readinessExplanation(o.readiness, o);
  switch (o.readiness) {
    case "ready":
      return { stage: "ready", attention: true, why: r.why, next: r.next, owner: "billing", href: billing };
    case "blocked":
      return { stage: "review", attention: true, why: r.why, next: r.next, owner: "billing", href: billing };
    case "needs_review":
    case "missing_documentation":
      return { stage: "tickets", attention: true, why: r.why, next: r.next, owner: "office", href: billing };
    case "in_progress":
    default:
      if (o.fulfillment_gap === "no_loads" || o.loads_total === 0) {
        return { stage: "dispatch", attention: true, why: FULFILLMENT_GAP_LABELS.no_loads + ".", next: "Plan the loads", owner: "dispatch", href: `/orders/${o.order_id}` };
      }
      if (o.fulfillment_gap === "quantity_short") {
        return { stage: "delivery", attention: true, why: r.why, next: r.next, owner: "dispatch", href: `/orders/${o.order_id}` };
      }
      return { stage: "delivery", attention: false, why: r.why, next: "Loads run as planned", owner: "none", href: `/orders/${o.order_id}` };
  }
}

/** Counts per stage and how many need attention, for the summary row. */
export function summarize(rows: OrderRow[]): { stage: Stage; total: number; attention: number; cents: number }[] {
  return STAGES.map((stage) => {
    const here = rows.map((o) => ({ o, l: lifecycle(o) })).filter((x) => x.l.stage === stage);
    return { stage, total: here.length, attention: here.filter((x) => x.l.attention).length, cents: here.reduce((s, x) => s + Number(x.o.total_cents ?? 0), 0) };
  });
}

/** Whole days an order has waited at its stage, from the last date the database records for it (never estimated). */
export function waitingDays(o: OrderRow, today: string): number | null {
  const since = o.handed_off_at?.slice(0, 10) ?? o.completed_at?.slice(0, 10) ?? (o.scheduled_start && o.scheduled_start <= today ? o.scheduled_start : o.order_date);
  if (!since) return null;
  return Math.max(0, Math.round((Date.parse(today) - Date.parse(since)) / 86_400_000));
}
