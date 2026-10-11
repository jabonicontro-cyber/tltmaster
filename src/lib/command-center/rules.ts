// Command center: exception kinds, explanations and links into the existing
// workflows. The database decides which exceptions exist, their priority and
// who may see them (private.operational_exceptions); this file only explains
// them. tests/db/command-center.test.ts checks the codes agree.

import { formatDate } from "@/lib/dates";
import { eligibilityMessage } from "@/lib/fleet/eligibility";
import { reviewReasonLabel } from "@/lib/tickets/rules";
import { URGENCY_LABELS, URGENCY_NEXT_OWNER, URGENCY_REASONS, type UrgencyState } from "@/lib/orders/urgency";

export const EXCEPTION_KINDS = [
  "urgent_order",
  "order_unscheduled",
  "unassigned_load",
  "assignment_problem",
  "missing_ticket",
  "ticket_review",
  "billing_blocked",
  "equipment_out_of_service",
  "delay_report",
  "equipment_report",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const KIND_LABELS: Record<ExceptionKind, string> = {
  urgent_order: "Urgent order",
  order_unscheduled: "Needs a delivery date",
  unassigned_load: "Load without a truck",
  assignment_problem: "Assignment problem",
  missing_ticket: "Missing delivery ticket",
  ticket_review: "Ticket to review",
  billing_blocked: "Billing blocked",
  equipment_out_of_service: "Equipment out of service",
  delay_report: "Driver report: delay",
  equipment_report: "Driver report: equipment",
};

/** Who normally handles each kind (the permission that resolves it). */
export const KIND_OWNERS: Record<ExceptionKind, string> = {
  urgent_order: "Dispatch",
  order_unscheduled: "Dispatch or office (scheduling)",
  unassigned_load: "Dispatch",
  assignment_problem: "Dispatch",
  missing_ticket: "Office or dispatch",
  ticket_review: "Office",
  billing_blocked: "Office (billing)",
  equipment_out_of_service: "Shop / fleet",
  delay_report: "Dispatch",
  equipment_report: "Shop / fleet or dispatch",
};

export const PRIORITY_LABELS: Record<number, string> = { 1: "Urgent", 2: "High", 3: "Normal" };

/** How priority is decided (shown on the page; mirrors the SQL). */
export const PRIORITY_RULES = [
  "Urgent: an order flagged urgent that dispatch has not acknowledged yet (or past its needed-by time), a confirmed order without a delivery date that the customer wants by tomorrow, a load today with no truck, an upcoming load (today or tomorrow) whose assignment the dispatch rules would now refuse, or a new driver report of a breakdown or a load that cannot be completed.",
  "High: an urgent order being worked on (acknowledged, evaluating, waiting or blocked), an unscheduled order requested within a week or confirmed more than two days ago, a delivered load without a ticket, a ticket flagged for review, a later assignment problem, equipment out of service with loads booked on it, or another new driver report.",
  "Normal: an urgent order with a truck assigned and not resolved yet, any other confirmed order without a delivery date, a ticket waiting for acceptance, an order blocked from billing by unacknowledged differences, equipment out of service with nothing booked, or a driver report already acknowledged.",
];

export interface ExceptionItem {
  exception_key: string;
  kind: ExceptionKind;
  priority: number;
  since: string | null;
  order_id: string | null;
  order_number: string | null;
  customer_name: string | null;
  load_id: string | null;
  load_number: number | null;
  load_date: string | null;
  ticket_id: string | null;
  ticket_number: string | null;
  equipment_kind: "truck" | "trailer" | null;
  equipment_id: string | null;
  unit_number: string | null;
  assignment_id: string | null;
  reasons: string[];
  details: Record<string, unknown>;
  assigned_to: string | null;
  assignee_name: string | null;
  assigned_at: string | null;
  assignment_note: string | null;
}

const REASONS: Record<string, string> = {
  no_ticket: "The load has ended and no delivery ticket was entered.",
  ticket_voided: "Its ticket was voided and not replaced.",
  not_assigned: "The load was never assigned a truck.",
  no_assignment: "No truck, trailer or driver is assigned.",
  assignment_removed: "Its assignment was removed and not replaced.",
  awaiting_acceptance: "Submitted and waiting for an office reviewer to accept it.",
  flagged_for_review: "Flagged for review by a reviewer.",
  exceptions_unacknowledged: "Quantity or documentation differences have not been acknowledged.",
  acknowledgment_outdated: "The differences changed after they were acknowledged.",
  out_of_service: "Marked out of service.",
  load_outside_schedule: "The load date is outside the order's scheduled dates.",
  report_delay: "The driver reported a delay.",
  report_cannot_complete: "The driver reported that the load cannot be completed.",
  report_breakdown: "The driver reported a breakdown.",
  report_equipment_issue: "The driver reported an equipment problem.",
  report_inspection_issue: "The driver reported an inspection problem.",
  report_acknowledged: "Acknowledged by the office; not resolved yet.",
  no_delivery_date: "Confirmed, but no delivery date is set, so it is not on the dispatch board.",
  requested_date_passed: "The customer's requested date has passed.",
  requested_date_soon: "The customer asked for delivery by tomorrow or today.",
};

export function reasonText(code: string): string {
  return REASONS[code] ?? URGENCY_REASONS[code] ?? (code in REVIEW_CODES ? reviewReasonLabel(code) : eligibilityMessage(code));
}
const REVIEW_CODES: Record<string, true> = {
  unit_differs_from_order_line: true,
  delivered_on_other_day: true,
  equipment_differs_from_assignment: true,
  missing_external_reference: true,
  additional_ticket_for_load: true,
  duplicate_external_reference: true,
};

/** Every reason code the app knows (for the parity test). */
export function knowsReason(code: string): boolean {
  return code in REASONS || code in URGENCY_REASONS || code in REVIEW_CODES || eligibilityMessage(code) !== code;
}

const loadRef = (e: ExceptionItem) => `${e.order_number ?? "Order"}${e.load_number !== null ? ` · load ${e.load_number}` : ""}`;

/** Short headline naming the affected record. */
export function exceptionTitle(e: ExceptionItem): string {
  switch (e.kind) {
    case "urgent_order":
      return `${e.order_number ?? "Order"} is urgent — ${URGENCY_LABELS[(e.details.state as UrgencyState) ?? "awaiting_acknowledgement"].toLowerCase()}`;
    case "order_unscheduled":
      return `${e.order_number ?? "Order"}${e.customer_name ? ` (${e.customer_name})` : ""} needs a delivery date`;
    case "missing_ticket":
      return `${loadRef(e)} has no delivery ticket`;
    case "unassigned_load":
      return `${loadRef(e)} today has no truck`;
    case "ticket_review":
      return `Ticket ${e.ticket_number} (${loadRef(e)}) ${e.details.status === "needs_review" ? "needs review" : "awaits acceptance"}`;
    case "billing_blocked":
      return `${e.order_number} is blocked from billing`;
    case "equipment_out_of_service":
      return `${e.equipment_kind === "trailer" ? "Trailer" : "Truck"} ${e.unit_number} is out of service`;
    case "assignment_problem":
      return `${loadRef(e)}${e.load_date ? ` on ${formatDate(e.load_date)}` : ""}: assignment no longer valid`;
    case "delay_report":
      return `${String(e.details.driver_name ?? "Driver")} reported ${e.details.report_kind === "cannot_complete" ? "a load that cannot be completed" : "a delay"} on ${loadRef(e)}`;
    case "equipment_report":
      return `${String(e.details.driver_name ?? "Driver")} reported a problem with ${e.equipment_kind === "trailer" ? "trailer" : "truck"} ${e.unit_number ?? ""} (${loadRef(e)})`;
  }
}

/** Why it needs attention: the record's own reasons plus key facts. */
export function exceptionReasons(e: ExceptionItem): string[] {
  const out = e.reasons.map(reasonText);
  if (e.kind === "urgent_order") {
    if (e.details.reason) out.unshift(`“${String(e.details.reason)}”`);
    if (e.details.state_note) out.push(`Note: ${String(e.details.state_note)}`);
    const n = Number(e.details.active_assignments ?? 0);
    out.push(n > 0 ? `${n} load${n === 1 ? " has" : "s have"} a truck assigned.` : "No truck assigned yet.");
  }
  if (e.kind === "order_unscheduled") {
    if (e.details.requested_date) out.push(`Requested for ${formatDate(String(e.details.requested_date))}.`);
    if (e.details.project_name) out.push(`Job: ${String(e.details.project_name)}`);
  }
  if (e.kind === "billing_blocked" && typeof e.details.exceptions_count === "number") {
    out.push(`${e.details.exceptions_count} difference${e.details.exceptions_count === 1 ? "" : "s"} to acknowledge.`);
  }
  if (e.kind === "equipment_out_of_service") {
    if (e.details.reason) out.push(`Reason: ${String(e.details.reason)}`);
    if (e.details.expected_return_date) out.push(`Expected back ${formatDate(String(e.details.expected_return_date))}.`);
    const n = Number(e.details.upcoming_loads ?? 0);
    if (n > 0) out.push(`${n} upcoming load${n === 1 ? " is" : "s are"} still booked on it.`);
  }
  if ((e.kind === "delay_report" || e.kind === "equipment_report") && e.details.description) {
    out.push(`“${String(e.details.description)}”`);
  }
  return out;
}

/** The recommended next step and the existing workflow that performs it. */
export function exceptionAction(e: ExceptionItem, can: { ticketsEdit: boolean; dispatch: boolean }): { label: string; href: string } {
  const board = (date: string | null, load: string | null) => `/dispatch?${new URLSearchParams({ ...(date ? { date } : {}), ...(load ? { load } : {}) })}`;
  switch (e.kind) {
    case "urgent_order":
      return { label: e.details.state === "awaiting_acknowledgement" && can.dispatch ? "Open and acknowledge" : "Open the order", href: `/orders/${e.order_id}` };
    case "missing_ticket":
      if (e.assignment_id && can.ticketsEdit) return { label: "Enter the ticket", href: `/tickets/new?load=${e.load_id}` };
      if (can.dispatch) return { label: e.assignment_id ? "Open the load" : "Assign or cancel the load", href: board(e.load_date, e.load_id) };
      return { label: "Open the billing order", href: `/billing/orders/${e.order_id}` };
    case "unassigned_load":
      return { label: "Assign a truck", href: board(e.load_date, e.load_id) };
    case "order_unscheduled":
      return can.dispatch ? { label: "Schedule it", href: "/dispatch#needs-scheduling" } : { label: "Open the order", href: `/orders/${e.order_id}` };
    case "ticket_review":
      return { label: "Review the ticket", href: `/tickets/${e.ticket_id}?queue=review` };
    case "billing_blocked":
      return { label: "Review the differences", href: `/billing/orders/${e.order_id}` };
    case "equipment_out_of_service":
      return { label: "Open the service record", href: `/fleet/${e.equipment_kind === "trailer" ? "trailers" : "trucks"}/${e.equipment_id}` };
    case "assignment_problem":
      return { label: "Reassign the load", href: board(e.load_date, e.load_id) };
    case "delay_report":
    case "equipment_report":
      return { label: "Open the report", href: `/field-reports/${String(e.details.report_id)}` };
  }
}

/** Who acts next: the assignee, else (urgent orders) the state's owner, else the usual role. */
export function exceptionOwner(e: ExceptionItem): string {
  if (e.assignee_name) return e.assignee_name;
  if (e.kind === "urgent_order") {
    const ack = e.details.acknowledged_by_name ? ` (acknowledged by ${String(e.details.acknowledged_by_name)})` : "";
    return `${URGENCY_NEXT_OWNER[(e.details.state as UrgencyState) ?? "awaiting_acknowledgement"]}${ack}`;
  }
  return KIND_OWNERS[e.kind];
}

/** "3 h", "2 d" — how long the issue has existed; null when unknown. */
export function ageLabel(since: string | null, now: Date = new Date()): string | null {
  if (!since) return null;
  const ms = now.getTime() - new Date(since).getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < 0) return "upcoming";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

// -----------------------------------------------------------------------------
// Overview metrics
// -----------------------------------------------------------------------------

export interface CommandSummary {
  as_of: string;
  today: string;
  exceptions: { total: number; urgent: number; mine: number; hidden?: number };
  by_kind: Partial<Record<ExceptionKind, number>>;
  /** Orders whose scheduled dates include today (orders.view). */
  orders_today?: number | null;
  /** Confirmed orders with no delivery date (dispatch.view or orders.view); absent before N14. */
  orders_unscheduled?: number | null;
  /** Open urgent flags (dispatch.view or orders.view). */
  urgent_orders?: number | null;
  loads_today: number | null;
  loads_today_assigned: number | null;
  unassigned_loads: number | null;
  assignment_problems: number | null;
  trucks_out_of_service: number | null;
  trailers_out_of_service: number | null;
  tickets_to_review: number | null;
  missing_tickets: number | null;
  billing_blocked: number | null;
  billing_ready: number | null;
  /** Open + acknowledged driver reports the caller may see; absent before N8. */
  driver_reports?: number | null;
  can: { dispatch: boolean; fleet: boolean; billing: boolean; tickets: boolean; assign: boolean; orders?: boolean };
}

export interface MetricCard {
  key: string;
  label: string;
  /** null = not available (no permission or not tracked) — never shown as 0. */
  value: number | null;
  sub: string;
  href: string | null;
  tone: "default" | "warn" | "bad" | "good";
}

const queue = (kind: ExceptionKind) => `/command-center?kind=${kind}#attention`;

/** The overview cards a caller may see, in display order. Missing permissions hide a card; untracked data says so. */
export function metricCards(s: CommandSummary): MetricCard[] {
  const cards: MetricCard[] = [];
  const warnIf = (n: number | null, tone: MetricCard["tone"] = "warn") => (n && n > 0 ? tone : "default");
  if (s.urgent_orders !== undefined && s.urgent_orders !== null) {
    cards.push({ key: "urgent_orders", label: "Urgent orders open", value: s.urgent_orders, sub: "Flagged by the office, until resolved", href: queue("urgent_order"), tone: warnIf(s.urgent_orders, "bad") });
  }
  if (s.orders_unscheduled !== undefined && s.orders_unscheduled !== null) {
    cards.push({ key: "orders_unscheduled", label: "Orders needing a delivery date", value: s.orders_unscheduled, sub: "Confirmed, not on the dispatch board yet", href: queue("order_unscheduled"), tone: warnIf(s.orders_unscheduled) });
  }
  if (s.orders_today !== undefined && s.orders_today !== null) {
    cards.push({ key: "orders_today", label: "Orders scheduled today", value: s.orders_today, sub: "Open the list for times and sites", href: "/orders?when=today", tone: "default" });
  }
  if (s.loads_today !== null) {
    cards.push({ key: "loads_today", label: "Loads today", value: s.loads_today, sub: `${s.loads_today_assigned ?? 0} assigned`, href: `/dispatch?date=${s.today}`, tone: "default" });
  }
  if (s.unassigned_loads !== null) {
    cards.push({ key: "unassigned_loads", label: "Loads today without a truck", value: s.unassigned_loads, sub: "Not yet run", href: queue("unassigned_load"), tone: warnIf(s.unassigned_loads, "bad") });
  }
  if (s.assignment_problems !== null) {
    cards.push({ key: "assignment_problems", label: "Assignment problems", value: s.assignment_problems, sub: "Upcoming loads the rules would now refuse", href: queue("assignment_problem"), tone: warnIf(s.assignment_problems, "bad") });
  }
  if (s.trucks_out_of_service !== null) {
    cards.push({
      key: "out_of_service",
      label: "Trucks out of service",
      value: s.trucks_out_of_service,
      sub: `${s.trailers_out_of_service ?? 0} trailer${s.trailers_out_of_service === 1 ? "" : "s"} out of service`,
      href: queue("equipment_out_of_service"),
      tone: warnIf(s.trucks_out_of_service),
    });
    cards.push({ key: "maintenance", label: "Maintenance due", value: null, sub: "Not tracked yet — no maintenance records exist", href: null, tone: "default" });
  }
  if (s.driver_reports !== undefined && s.driver_reports !== null) {
    cards.push({ key: "driver_reports", label: "Driver reports open", value: s.driver_reports, sub: "Delays, breakdowns, inspection problems", href: "/field-reports", tone: warnIf(s.driver_reports, "bad") });
  }
  if (s.missing_tickets !== null) {
    cards.push({ key: "missing_tickets", label: "Missing delivery tickets", value: s.missing_tickets, sub: "Delivered loads without a ticket", href: queue("missing_ticket"), tone: warnIf(s.missing_tickets) });
  }
  if (s.tickets_to_review !== null) {
    cards.push({ key: "tickets_to_review", label: "Tickets to review", value: s.tickets_to_review, sub: "Submitted or flagged", href: queue("ticket_review"), tone: warnIf(s.tickets_to_review) });
  }
  if (s.billing_blocked !== null) {
    cards.push({ key: "billing_blocked", label: "Orders blocked from billing", value: s.billing_blocked, sub: "Differences to acknowledge", href: "/billing?view=exceptions", tone: warnIf(s.billing_blocked) });
  }
  if (s.billing_ready !== null) {
    cards.push({ key: "billing_ready", label: "Orders ready to bill", value: s.billing_ready, sub: "Hand off for invoicing", href: "/billing?view=ready", tone: warnIf(s.billing_ready, "good") });
  }
  return cards;
}
