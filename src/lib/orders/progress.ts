// Where an order stands across the modules that share its records: dispatch
// (loads and assignments), delivery tickets and billing readiness. Everything is
// derived from those records — nothing here is stored or copied — so a ticket
// correction or a new assignment shows up the next time the page loads.
// Driver pay is not tracked yet and is never inferred from billing.

import { READINESS_LABELS, readinessExplanation, type Readiness, type ReadinessCounts } from "@/lib/billing/rules";

export type StepState = "done" | "attention" | "waiting" | "not_started" | "unavailable";

export interface ProgressStep {
  key: "dispatch" | "tickets" | "billing";
  label: string;
  state: StepState;
  summary: string;
  /** Who handles the next action, when there is one. */
  owner?: string;
  next?: { label: string; href: string };
}

export interface ProgressLoad {
  id: string;
  status: "planned" | "canceled";
  load_date: string;
  ends_at: string;
  assigned: boolean;
  /** Live (not voided or superseded) tickets on the load. */
  tickets: Array<{ id: string; status: "submitted" | "needs_review" | "accepted" | "voided" | "superseded" }>;
}

export interface ProgressInput {
  orderId: string;
  orderStatus: string;
  loads: ProgressLoad[];
  /** The order's billing readiness, or null when the viewer may not see billing. */
  billing: (ReadinessCounts & { readiness: Readiness }) | null;
  now: Date;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function orderProgress(i: ProgressInput): ProgressStep[] {
  const planned = i.loads.filter((l) => l.status === "planned");
  const unassigned = planned.filter((l) => !l.assigned);
  // Same rule as billing readiness (billing_load_status.is_due): the load has ended, or the order is completed.
  const due = planned.filter((l) => i.orderStatus === "completed" || new Date(l.ends_at).getTime() <= i.now.getTime());
  const live = (l: ProgressLoad) => l.tickets.filter((t) => t.status !== "voided" && t.status !== "superseded");
  const missing = due.filter((l) => live(l).length === 0);
  const pending = planned.flatMap(live).filter((t) => t.status === "submitted" || t.status === "needs_review");
  const accepted = planned.flatMap(live).filter((t) => t.status === "accepted");
  const closed = i.orderStatus === "canceled";
  const board = (l?: ProgressLoad) => `/dispatch?${new URLSearchParams(l ? { date: l.load_date, load: l.id } : {})}`;

  const steps: ProgressStep[] = [];

  // Dispatch
  if (closed) {
    steps.push({ key: "dispatch", label: "Dispatch", state: "unavailable", summary: "Order canceled." });
  } else if (planned.length === 0) {
    steps.push({
      key: "dispatch", label: "Dispatch", state: "not_started",
      summary: i.orderStatus === "draft" || i.orderStatus === "confirmed" ? "No loads yet. Schedule the order, then plan its loads." : "No loads planned yet.",
      owner: "Dispatch", next: ["scheduled", "dispatched", "in_progress", "partially_completed"].includes(i.orderStatus) ? { label: "Plan loads", href: board() } : undefined,
    });
  } else if (unassigned.length > 0) {
    steps.push({
      key: "dispatch", label: "Dispatch", state: "attention",
      summary: `${plural(unassigned.length, "load")} of ${planned.length} without a truck and driver.`,
      owner: "Dispatch", next: { label: "Assign", href: board(unassigned[0]) },
    });
  } else {
    steps.push({ key: "dispatch", label: "Dispatch", state: "done", summary: `${plural(planned.length, "load")}, all assigned.` });
  }

  // Delivery tickets
  if (closed || planned.length === 0) {
    steps.push({ key: "tickets", label: "Delivery tickets", state: closed ? "unavailable" : "not_started", summary: closed ? "Order canceled." : "Tickets follow delivered loads." });
  } else if (missing.length > 0) {
    steps.push({
      key: "tickets", label: "Delivery tickets", state: "attention",
      summary: `${plural(missing.length, "delivered load")} without a ticket.${pending.length ? ` ${plural(pending.length, "ticket")} to review.` : ""}`,
      owner: "Office or dispatch", next: { label: "Enter the ticket", href: `/tickets/new?load=${missing[0].id}` },
    });
  } else if (pending.length > 0) {
    steps.push({
      key: "tickets", label: "Delivery tickets", state: "attention",
      summary: `${plural(pending.length, "ticket")} received, not verified yet (accept, correct or void).`,
      owner: "Office (ticket review)", next: { label: "Review", href: `/tickets/${pending[0].id}?queue=review&order=${i.orderId}` },
    });
  } else if (due.length < planned.length) {
    steps.push({
      key: "tickets", label: "Delivery tickets", state: "waiting",
      summary: `${plural(accepted.length, "ticket")} verified; ${plural(planned.length - due.length, "load")} not delivered yet.`,
    });
  } else {
    steps.push({ key: "tickets", label: "Delivery tickets", state: "done", summary: `All ${plural(planned.length, "load")} have verified tickets.` });
  }

  // Billing readiness (separate from payroll; nothing is invoiced here)
  if (!i.billing) {
    steps.push({ key: "billing", label: "Billing readiness", state: "unavailable", summary: "Shown to people with billing access." });
  } else {
    const r = i.billing.readiness;
    const exp = readinessExplanation(r, i.billing);
    steps.push({
      key: "billing", label: "Billing readiness",
      state: r === "ready" ? "attention" : r === "handed_off" ? "done" : r === "in_progress" ? "waiting" : "attention",
      summary: `${READINESS_LABELS[r]}: ${exp.why}`,
      owner: r === "handed_off" ? undefined : r === "in_progress" ? "Office: mark the order completed when all work is done" : "Office (billing)",
      next: r === "handed_off" || r === "in_progress" ? undefined : { label: r === "ready" ? "Hand off" : "Open billing", href: `/billing/orders/${i.orderId}` },
    });
  }
  return steps;
}
