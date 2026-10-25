// Billing readiness labels, explanations and the handoff file format. The
// database is authoritative (views billing_load_status, billing_line_status,
// billing_exceptions, billing_order_status); this file only explains its
// results. tests/db/billing.test.ts checks the codes agree.

import { centsToInput } from "@/lib/money";

export const READINESS = ["missing_documentation", "needs_review", "blocked", "in_progress", "ready", "handed_off"] as const;
export type Readiness = (typeof READINESS)[number];

export const READINESS_LABELS: Record<Readiness, string> = {
  missing_documentation: "Missing documentation",
  needs_review: "Tickets need review",
  blocked: "Blocked — exceptions",
  in_progress: "Work not completed",
  ready: "Ready to bill",
  handed_off: "Handed off",
};

/**
 * Why an order is not fulfilled yet (view order_fulfillment). An order is
 * fulfilled when every planned load has run and has an accepted ticket, no
 * ticket waits for review, and every ticketed line has at least its ordered
 * quantity accepted. A fulfilled order can be billed without marking it
 * Completed; a partly delivered one cannot.
 */
export const FULFILLMENT_GAPS = ["no_loads", "loads_upcoming", "tickets_pending", "loads_without_accepted_ticket", "tickets_other_unit", "quantity_short", "no_accepted_tickets"] as const;
export type FulfillmentGap = (typeof FULFILLMENT_GAPS)[number];

export const FULFILLMENT_GAP_LABELS: Record<FulfillmentGap, string> = {
  no_loads: "No loads are planned",
  loads_upcoming: "Loads are still to run",
  tickets_pending: "Tickets are waiting for review",
  loads_without_accepted_ticket: "A delivered load has no accepted ticket",
  tickets_other_unit: "A ticket is in a different unit than its order line",
  quantity_short: "Delivered less than ordered (partial delivery)",
  no_accepted_tickets: "No accepted tickets yet",
};

export interface ReadinessCounts {
  status: string;
  fulfilled?: boolean;
  fulfillment_gap?: FulfillmentGap | null;
  loads_missing: number;
  loads_not_due: number;
  tickets_live: number;
  tickets_pending: number;
  exceptions_count: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why an order has its readiness, and what resolves it. */
/** Short next step for lists; the full explanation (`action`) is on the order's billing page. */
const NEXT_STEP: Record<Readiness, (o: ReadinessCounts) => string> = {
  missing_documentation: (o) => (o.loads_missing > 0 ? "Enter the missing tickets" : "Enter the tickets"),
  needs_review: () => "Review the tickets",
  blocked: () => "Resolve the exceptions",
  in_progress: (o) => (o.fulfillment_gap === "quantity_short" ? "Plan the rest, or complete the order" : "Finish the loads, or complete the order"),
  ready: () => "Hand off for billing",
  handed_off: () => "Enter the invoice in accounting",
};

export function readinessExplanation(readiness: Readiness, o: ReadinessCounts): { why: string; action: string; next: string } {
  return { ...explain(readiness, o), next: NEXT_STEP[readiness](o) };
}

function explain(readiness: Readiness, o: ReadinessCounts): { why: string; action: string } {
  switch (readiness) {
    case "missing_documentation":
      return o.loads_missing > 0
        ? { why: `${plural(o.loads_missing, "delivered load")} without a delivery ticket.`, action: "Enter the ticket from the paper copy, or cancel the load if it did not run." }
        : { why: "The order is completed but has no delivery tickets.", action: "Enter the tickets for its loads (plan the loads on the dispatch board first if none exist)." };
    case "needs_review":
      return { why: `${plural(o.tickets_pending, "ticket")} not accepted yet.`, action: "Open each ticket and accept, correct or void it." };
    case "blocked":
      return { why: `${plural(o.exceptions_count, "exception")} not acknowledged.`, action: "Check the differences below and acknowledge them with a reason, or correct the tickets." };
    case "in_progress":
      return {
        // "Loads are still to run" would repeat the count just given, so it is left out when the count is shown.
        why: `Order is ${o.status.replace(/_/g, " ")}${o.loads_not_due ? `; ${plural(o.loads_not_due, "load")} still to run` : ""}${o.fulfillment_gap && !(o.fulfillment_gap === "loads_upcoming" && o.loads_not_due) ? ` — not fully delivered: ${FULFILLMENT_GAP_LABELS[o.fulfillment_gap].toLowerCase()}` : ""}.`,
        action: o.fulfillment_gap === "quantity_short"
          ? "Partly delivered orders stay out of billing. Plan the remaining loads, or mark the order Completed if the rest will not be delivered."
          : "It becomes billable once every load has run with an accepted ticket and the ordered quantities are delivered — or mark the order Completed when all work is done.",
      };
    case "ready":
      return {
        why: o.status === "completed"
          ? "All loads have accepted tickets and every exception is resolved."
          : "Fully delivered: every planned load has an accepted ticket, the ordered quantities are delivered, and every exception is resolved.",
        action: "Hand it off for billing.",
      };
    case "handed_off":
      return { why: "Handed off for billing.", action: "Enter the invoice in your accounting system. Undo the handoff only if it was a mistake." };
  }
}

export const EXCEPTION_KINDS = ["load_quantity", "load_units_differ", "line_quantity", "line_units_differ", "line_no_tickets", "line_zero_rate", "po_missing"] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const EXCEPTION_LABELS: Record<ExceptionKind, string> = {
  load_quantity: "Load: delivered differs from planned",
  load_units_differ: "Load: units cannot be compared",
  line_quantity: "Order line: delivered differs from ordered",
  line_units_differ: "Order line: units cannot be compared",
  line_no_tickets: "Order line: no ticket",
  line_zero_rate: "Order line: no rate",
  po_missing: "Customer PO missing",
};

export const EXCEPTION_HELP: Record<ExceptionKind, string> = {
  load_quantity: "The tickets on this load add up to a different quantity than was planned. Confirm the tickets are right before billing.",
  load_units_differ: "A ticket on this load is in a different unit than the plan, so they cannot be compared. No conversion is made.",
  line_quantity: "Accepted deliveries add up to a different quantity than the order line. The order's price is not changed — decide what to invoice.",
  line_units_differ: "A ticket for this line is in a different unit than the line, so they cannot be compared. No conversion is made.",
  line_no_tickets: "No delivery ticket references this line (often a hauling or service charge). Confirm the quantity to invoice.",
  line_zero_rate: "This line has a rate of $0.00. Confirm it is intentional.",
  po_missing: "The customer requires a PO number and the order has none.",
};

/** Exact-match policy: the database flags any difference; nothing is tolerated silently. */
export const QUANTITY_POLICY =
  "Quantities are compared only in the same unit and must match exactly. Any difference, a unit that cannot be compared, or a line without tickets is an exception the office acknowledges with a reason. Nothing is converted or assumed to be zero.";

export const LOAD_STATES = ["missing", "not_due", "needs_review", "documented"] as const;
export type LoadDocumentationState = (typeof LOAD_STATES)[number];

export const QUANTITY_CHECKS = ["no_tickets", "not_planned", "units_differ", "match", "over", "under", "in_progress"] as const;
export type QuantityCheck = (typeof QUANTITY_CHECKS)[number];

export const QUANTITY_CHECK_LABELS: Record<QuantityCheck, string> = {
  no_tickets: "No tickets",
  not_planned: "Not compared — no planned quantity",
  units_differ: "Not compared — units differ",
  match: "Matches",
  over: "Over",
  under: "Under",
  in_progress: "Compared when the order is completed",
};

/** Signed difference text: "+1.5" / "-0.53". */
export function formatDifference(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const s = String(value).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s.startsWith("-") ? s : s === "0" ? "0" : `+${s}`;
}

// -----------------------------------------------------------------------------
// Handoff file (CSV). A plain list of what was handed off, one row per order
// line — NOT a QuickBooks import format. Columns map to QuickBooks fields only
// by hand (see docs/IMPLEMENTATION_PLAN.md §5e).
// -----------------------------------------------------------------------------

export const HANDOFF_CSV_FORMAT = "tlt-billing-handoff-v1";

export const HANDOFF_CSV_COLUMNS = [
  "format",
  "batch_number",
  "batch_reference",
  "order_number",
  "order_id",
  "customer_number",
  "customer_name",
  "customer_po",
  "project",
  "service_start",
  "service_end",
  "line_no",
  "line_id",
  "description",
  "unit",
  "ordered_quantity",
  "delivered_quantity_accepted",
  "unit_rate",
  "percent",
  "line_amount",
  "taxable",
  "price_source",
  "order_subtotal",
  "order_discounts",
  "order_tax",
  "order_total",
  "ticket_numbers",
  "paper_ticket_numbers",
] as const;

export interface HandoffSnapshot {
  order: {
    order_id: string;
    order_number: string;
    customer_number: string | null;
    customer_name: string | null;
    project_name: string;
    customer_po: string;
    service_start: string | null;
    service_end: string | null;
    subtotal_cents: number;
    discount_cents: number;
    tax_cents: number;
    total_cents: number;
  };
  lines: Array<{
    line_id: string;
    line_no: number;
    kind: string;
    calc_method: string;
    description: string;
    unit_code: string | null;
    quantity: number | string | null;
    unit_rate_cents: number | null;
    percent_bp: number | null;
    amount_cents: number;
    price_source: string;
    taxable: boolean;
    delivered_quantity: number | string | null;
    /** The business that bills this line (20261120003400); absent when the company has no billing businesses. */
    billing_entity_id?: string | null;
    billing_entity_name?: string | null;
  }>;
  tickets: Array<{
    ticket_number: string;
    order_line_id: string;
    quantity: number | string;
    unit_code: string;
    external_reference: string;
  }>;
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  // Quote everything that needs it; neutralize spreadsheet formulas.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function qty(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Rows of the handoff file for a batch, in order number and line order. */
export function handoffCsv(batch: { batch_number: string; reference: string }, orders: HandoffSnapshot[]): string {
  const rows: string[][] = [HANDOFF_CSV_COLUMNS.slice()];
  const sorted = [...orders].sort((a, b) => a.order.order_number.localeCompare(b.order.order_number));
  for (const { order: o, lines, tickets } of sorted) {
    for (const l of [...lines].sort((a, b) => a.line_no - b.line_no)) {
      const lt = tickets.filter((t) => t.order_line_id === l.line_id).sort((a, b) => a.ticket_number.localeCompare(b.ticket_number));
      rows.push([
        HANDOFF_CSV_FORMAT,
        batch.batch_number,
        batch.reference,
        o.order_number,
        o.order_id,
        o.customer_number ?? "",
        o.customer_name ?? "",
        o.customer_po,
        o.project_name,
        o.service_start ?? "",
        o.service_end ?? "",
        String(l.line_no),
        l.line_id,
        l.description,
        l.unit_code ?? "",
        qty(l.quantity),
        l.calc_method === "per_unit" && l.kind !== "discount" ? qty(l.delivered_quantity) : "",
        l.unit_rate_cents === null ? "" : centsToInput(l.unit_rate_cents),
        l.percent_bp === null ? "" : (l.percent_bp / 100).toString(),
        centsToInput(l.amount_cents),
        l.taxable ? "yes" : "no",
        l.price_source,
        centsToInput(o.subtotal_cents),
        centsToInput(o.discount_cents),
        centsToInput(o.tax_cents),
        centsToInput(o.total_cents),
        lt.map((t) => t.ticket_number).join(" "),
        lt.map((t) => t.external_reference).filter(Boolean).join(" "),
      ]);
    }
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
