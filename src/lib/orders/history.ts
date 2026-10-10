// Turns order audit entries and status events into one readable timeline.
import type { OrderStatus } from "@/server/data/types";

export const ORDER_FIELD_LABELS: Record<string, string> = {
  contact_id: "Saved contact",
  contact_name: "Contact name",
  contact_email: "Contact email",
  contact_phone: "Contact phone",
  site_id: "Saved job site",
  site_label: "Job site name",
  site_line1: "Job site address",
  site_line2: "Job site address line 2",
  site_city: "Job site city",
  site_state: "Job site state",
  site_postal_code: "Job site ZIP",
  project_name: "Project",
  customer_po: "Customer PO",
  job_instructions: "Job instructions",
  internal_notes: "Internal notes",
  requested_date: "Requested delivery",
  order_date: "Order date",
  scheduled_start: "Scheduled date",
  scheduled_end: "Scheduled through",
  window_start: "Window from",
  window_end: "Window to",
  scheduling_notes: "Scheduling notes",
  customer_id: "Customer",
  tax_rate_bp: "Tax rate",
  terms: "Terms",
  total_cents: "Total",
};

/** Fields whose old/new values are not shown (ids, long text). */
const VALUE_HIDDEN = new Set(["contact_id", "site_id", "customer_id", "job_instructions", "internal_notes", "terms", "scheduling_notes"]);

export interface FieldChange {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "total_cents" && typeof value === "number") return `$${(value / 100).toFixed(2)}`;
  if (field === "tax_rate_bp" && typeof value === "number") return `${(value / 100).toFixed(2)}%`;
  if ((field === "window_start" || field === "window_end") && typeof value === "string") return value.slice(0, 5);
  return String(value);
}

export function describeChanges(changes: unknown): FieldChange[] {
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes as Record<string, { from?: unknown; to?: unknown }>)
    .filter(([field]) => field in ORDER_FIELD_LABELS)
    .map(([field, c]) => ({
      field,
      label: ORDER_FIELD_LABELS[field],
      from: VALUE_HIDDEN.has(field) ? null : show(field, c?.from),
      to: VALUE_HIDDEN.has(field) ? null : show(field, c?.to),
    }))
    .sort((a, b) => Object.keys(ORDER_FIELD_LABELS).indexOf(a.field) - Object.keys(ORDER_FIELD_LABELS).indexOf(b.field));
}

export type TimelineEntry =
  | { kind: "status"; id: string; at: string; actorId: string | null; from: OrderStatus | null; to: OrderStatus; note: string }
  | { kind: "change"; id: string; at: string; actorId: string | null; summary: string; changes: FieldChange[] };

/**
 * Status events come from order_status_events; everything else from the
 * audit log. Audit entries for status changes duplicate the events and are
 * left out. Newest first.
 */
export function buildOrderTimeline(
  events: Array<{ id: string; occurred_at: string; actor_id: string | null; from_status: OrderStatus | null; to_status: OrderStatus; note: string }>,
  audit: Array<{ id: string; occurred_at: string; actor_id: string | null; action: string; summary: string; details: Record<string, unknown> }>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...events.map((e) => ({ kind: "status" as const, id: e.id, at: e.occurred_at, actorId: e.actor_id, from: e.from_status, to: e.to_status, note: e.note })),
    ...audit
      .filter((a) => a.action !== "order.status_changed")
      .map((a) => ({ kind: "change" as const, id: a.id, at: a.occurred_at, actorId: a.actor_id, summary: a.summary, changes: describeChanges(a.details?.changes) })),
  ];
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind === "status" ? -1 : 1));
}
