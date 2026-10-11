import "server-only";
import { buildInvoiceDraft, type DraftOrderLine, type DraftTicket } from "@/lib/billing/invoice-draft";
import { uuid } from "@/lib/schemas/common";
import type { ExceptionKind, FulfillmentGap, HandoffSnapshot, LoadDocumentationState, QuantityCheck, Readiness, ReadinessCounts } from "@/lib/billing/rules";
import type { TicketStatus } from "@/lib/tickets/rules";
import { createClient } from "@/server/supabase/server";
import { getUserNames } from "./quotes";
import { businessToday } from "./settings";
import { resourceNames, type TicketRow } from "./tickets";

type Num = number | string;

export interface BillingOrderRow {
  order_id: string;
  order_number: string;
  status: string;
  customer_id: string;
  customer_name: string | null;
  customer_number: string | null;
  project_name: string;
  customer_po: string;
  order_date: string;
  service_start: string | null;
  service_end: string | null;
  completed_at: string | null;
  total_cents: number;
  loads_total: number;
  loads_due: number;
  loads_missing: number;
  loads_not_due: number;
  tickets_live: number;
  tickets_pending: number;
  tickets_accepted: number;
  documents_fingerprint: string;
  exceptions_count: number;
  exceptions_fingerprint: string;
  acknowledgment_id: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  acknowledgment_reason: string | null;
  last_acknowledged_at: string | null;
  handoff_order_id: string | null;
  handoff_id: string | null;
  batch_number: string | null;
  handoff_reference: string | null;
  handed_off_at: string | null;
  handed_off_by: string | null;
  changed_since_handoff: boolean;
  fulfilled: boolean;
  fulfillment_gap: FulfillmentGap | null;
  readiness: Readiness;
}

export interface BillingLoadRow {
  load_id: string;
  order_id: string;
  order_number: string;
  order_status: string;
  customer_id: string;
  customer_name: string | null;
  load_number: number;
  load_date: string;
  start_time: string;
  end_time: string;
  ends_at: string;
  planned_quantity: Num | null;
  planned_unit_code: string | null;
  assignment_id: string | null;
  truck_id: string | null;
  trailer_id: string | null;
  driver_id: string | null;
  is_due: boolean;
  live_count: number;
  accepted_count: number;
  pending_count: number;
  other_unit_count: number;
  delivered_quantity: Num | null;
  ticket_units: string[] | null;
  live_numbers: string[] | null;
  voided_numbers: string[] | null;
  documentation_state: LoadDocumentationState;
  quantity_check: QuantityCheck;
  quantity_difference: Num | null;
}

export interface BillingLineRow {
  line_id: string;
  order_id: string;
  line_no: number;
  kind: string;
  description: string;
  unit_code: string;
  ordered_quantity: Num;
  unit_rate_cents: number;
  amount_cents: number;
  price_source: string;
  live_count: number;
  pending_count: number;
  other_unit_count: number;
  delivered_quantity: Num | null;
  ticket_units: string[] | null;
  quantity_check: QuantityCheck;
  quantity_difference: Num | null;
  pricing_check: "ok" | "zero_rate";
}

export interface BillingExceptionRow {
  order_id: string;
  kind: ExceptionKind;
  load_id: string | null;
  line_id: string | null;
  load_number: number | null;
  line_no: number | null;
  expected_quantity: Num | null;
  actual_quantity: Num | null;
  unit_code: string | null;
  ticket_units: string[] | null;
  difference: Num | null;
}

export const BILLING_VIEWS = {
  orders: "All orders",
  missing: "Missing tickets",
  review: "Tickets to review",
  exceptions: "Exceptions",
  ready: "Ready to bill",
  handed_off: "Handed off",
} as const;
export type BillingView = keyof typeof BILLING_VIEWS;

export interface BillingFilters {
  q?: string;
  from?: string;
  to?: string;
  customer?: string;
  kind?: string;
  readiness?: string;
}

function matches(o: BillingOrderRow, f: BillingFilters) {
  if (f.customer && o.customer_id !== f.customer) return false;
  if (f.from && (o.service_end ?? o.order_date) < f.from) return false;
  if (f.to && (o.service_start ?? o.order_date) > f.to) return false;
  if (f.readiness && o.readiness !== f.readiness) return false;
  const q = f.q?.trim().toLowerCase();
  if (q) {
    const hay = [o.order_number, o.customer_name, o.customer_number, o.customer_po, o.project_name].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/**
 * Everything the billing screen needs. Readiness comes from the database views
 * (derived from the records each time); filters are applied to the open orders.
 */
export async function getBillingBoard(view: BillingView, f: BillingFilters) {
  const supabase = await createClient();
  const [orders, handedOffCount, { timezone }] = await Promise.all([
    supabase.from("billing_order_status").select("*").neq("readiness", "handed_off").order("service_start", { ascending: false, nullsFirst: false }).limit(2000),
    supabase.from("billing_handoff_orders").select("id", { count: "exact", head: true }).is("reverted_at", null),
    businessToday(),
  ]);
  if (orders.error) throw new Error(`Could not load billing status: ${orders.error.message}`);
  const all = (orders.data ?? []) as BillingOrderRow[];
  const filtered = all.filter((o) => matches(o, view === "orders" ? f : { ...f, readiness: undefined }));
  const orderIds = new Set(filtered.map((o) => o.order_id));
  const byId = new Map(all.map((o) => [o.order_id, o]));

  const [missingCount, pendingCount, customers] = await Promise.all([
    supabase.from("billing_load_status").select("load_id", { count: "exact", head: true }).eq("documentation_state", "missing"),
    supabase.from("billing_load_status").select("pending_count").gt("pending_count", 0),
    supabase.from("customers").select("id, name").order("name"),
  ]);
  const counts: Record<BillingView, number> = {
    orders: all.length,
    missing: missingCount.count ?? 0,
    review: ((pendingCount.data ?? []) as Array<{ pending_count: number }>).reduce((n, r) => n + r.pending_count, 0),
    exceptions: all.filter((o) => o.exceptions_count > 0 && !o.acknowledgment_id).length,
    ready: all.filter((o) => o.readiness === "ready").length,
    handed_off: handedOffCount.count ?? 0,
  };
  const base = { counts, customers: (customers.data ?? []) as Array<{ id: string; name: string }>, timezone };

  if (view === "missing") {
    const { data, error } = await supabase.from("billing_load_status").select("*").eq("documentation_state", "missing").order("load_date").order("start_time").limit(1000);
    if (error) throw new Error(`Could not load loads: ${error.message}`);
    const names = await resourceNames();
    const loads = ((data ?? []) as BillingLoadRow[])
      .filter((l) => orderIds.has(l.order_id) && (!f.from || l.load_date >= f.from) && (!f.to || l.load_date <= f.to))
      .map((l) => ({
        ...l,
        truck: l.truck_id ? names.trucks.get(l.truck_id) ?? "—" : null,
        trailer: l.trailer_id ? names.trailers.get(l.trailer_id) ?? "—" : null,
        driver: l.driver_id ? names.drivers.get(l.driver_id) ?? "—" : null,
      }));
    return { ...base, view, loads };
  }

  if (view === "review") {
    const { data, error } = await supabase.from("delivery_tickets").select("*").in("status", ["submitted", "needs_review"]).order("delivered_at").limit(1000);
    if (error) throw new Error(`Could not load tickets: ${error.message}`);
    const tickets = ((data ?? []) as TicketRow[]).filter((t) => orderIds.has(t.order_id));
    return { ...base, view, tickets, orders: byId };
  }

  if (view === "exceptions") {
    const { data, error } = await supabase.from("billing_exceptions").select("*").limit(2000);
    if (error) throw new Error(`Could not load exceptions: ${error.message}`);
    const rows = ((data ?? []) as BillingExceptionRow[]).filter((e) => orderIds.has(e.order_id) && (!f.kind || e.kind === f.kind));
    const groups = filtered
      .filter((o) => rows.some((e) => e.order_id === o.order_id))
      .map((o) => ({ order: o, exceptions: rows.filter((e) => e.order_id === o.order_id) }));
    return { ...base, view, groups, people: await getUserNames() };
  }

  if (view === "handed_off") {
    return { ...base, view, ...(await listHandoffs(f)) };
  }

  const orderRows = view === "ready" ? filtered.filter((o) => o.readiness === "ready") : filtered;
  return { ...base, view, orders: orderRows };
}

export type BillingBoard = Awaited<ReturnType<typeof getBillingBoard>>;

export interface HandoffBatchRow {
  id: string;
  batch_number: string;
  reference: string;
  notes: string;
  created_by: string | null;
  created_at: string;
  export_count: number;
  last_exported_at: string | null;
  last_exported_by: string | null;
}

export interface HandoffOrderRow {
  id: string;
  handoff_id: string;
  order_id: string;
  documents_fingerprint: string;
  reverted_at: string | null;
  reverted_by: string | null;
  revert_reason: string;
  order: HandoffSnapshot["order"];
}

async function listHandoffs(f: BillingFilters) {
  const supabase = await createClient();
  const { data: batches, error } = await supabase.from("billing_handoffs").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(`Could not load handoffs: ${error.message}`);
  const ids = ((batches ?? []) as HandoffBatchRow[]).map((b) => b.id);
  const [items, current, people] = await Promise.all([
    ids.length
      ? supabase.from("billing_handoff_orders").select("id, handoff_id, order_id, documents_fingerprint, reverted_at, reverted_by, revert_reason, order:snapshot->order").in("handoff_id", ids)
      : Promise.resolve({ data: [] }),
    supabase.from("billing_order_status").select("order_id, changed_since_handoff, handoff_order_id").eq("readiness", "handed_off"),
    getUserNames(),
  ]);
  const changed = new Set(((current.data ?? []) as Array<{ handoff_order_id: string; changed_since_handoff: boolean }>).filter((r) => r.changed_since_handoff).map((r) => r.handoff_order_id));
  const q = f.q?.trim().toLowerCase();
  const rows = ((items.data ?? []) as HandoffOrderRow[]).filter((r) => {
    if (f.customer || q) {
      const hay = [r.order.order_number, r.order.customer_name, r.order.customer_po, r.order.project_name].join(" ").toLowerCase();
      if (q && !hay.includes(q)) return false;
    }
    if (f.from && (r.order.service_end ?? "") < f.from) return false;
    if (f.to && (r.order.service_start ?? "9999") > f.to) return false;
    return true;
  });
  const batchList = ((batches ?? []) as HandoffBatchRow[])
    .map((b) => ({
      batch: b,
      orders: rows
        .filter((r) => r.handoff_id === b.id)
        .sort((a, c) => a.order.order_number.localeCompare(c.order.order_number))
        .map((r) => ({ ...r, changed: changed.has(r.id) })),
    }))
    .filter((b) => b.orders.length > 0 || !(q || f.from || f.to));
  return { batches: batchList, people };
}

/** One order's billing picture: readiness, loads, lines, exceptions, decisions and handoffs. */
export async function getOrderBilling(orderId: string) {
  if (!uuid.safeParse(orderId).success) return null;
  const supabase = await createClient();
  const { data: status } = await supabase.from("billing_order_status").select("*").eq("order_id", orderId).maybeSingle();
  if (!status) return null;
  const [loads, lines, exceptions, reviews, handoffs, tickets, names, people, { timezone }, orderLines, order] = await Promise.all([
    supabase.from("billing_load_status").select("*").eq("order_id", orderId).order("load_number"),
    supabase.from("billing_line_status").select("*").eq("order_id", orderId).order("line_no"),
    supabase.from("billing_exceptions").select("*").eq("order_id", orderId),
    supabase.from("billing_reviews").select("*").eq("order_id", orderId).order("decided_at", { ascending: false }),
    supabase.from("billing_handoff_orders").select("id, handoff_id, reverted_at, reverted_by, revert_reason, batch:billing_handoffs(batch_number, reference, created_at, created_by)").eq("order_id", orderId),
    supabase.from("delivery_tickets").select("id, load_id, order_line_id, ticket_number, revision, status, quantity, unit_code, external_reference").eq("order_id", orderId).neq("status", "superseded").order("ticket_number"),
    resourceNames(),
    getUserNames(),
    businessToday(),
    // Every line (percentages and discounts too) and the order's tax rate, for the invoice draft.
    supabase.from("order_lines").select("id, line_no, kind, calc_method, description, unit_code, quantity, unit_rate_cents, percent_bp, taxable, amount_cents").eq("order_id", orderId).order("line_no"),
    supabase.from("orders").select("tax_rate_bp, total_cents").eq("id", orderId).maybeSingle(),
  ]);
  const draft = buildInvoiceDraft({
    lines: (orderLines.data ?? []) as DraftOrderLine[],
    tickets: (tickets.data ?? []) as DraftTicket[],
    taxRateBp: (order.data as { tax_rate_bp: number } | null)?.tax_rate_bp ?? 0,
    orderTotalCents: (order.data as { total_cents: number } | null)?.total_cents ?? (status as BillingOrderRow).total_cents,
    readiness: (status as BillingOrderRow).readiness,
  });
  return {
    draft,
    status: status as BillingOrderRow,
    loads: (loads.data ?? []) as BillingLoadRow[],
    lines: (lines.data ?? []) as BillingLineRow[],
    exceptions: (exceptions.data ?? []) as BillingExceptionRow[],
    reviews: (reviews.data ?? []) as Array<{ id: string; fingerprint: string; reason: string; decided_by: string | null; decided_at: string; exceptions: BillingExceptionRow[] }>,
    handoffs: (handoffs.data ?? []) as unknown as Array<{
      id: string;
      handoff_id: string;
      reverted_at: string | null;
      reverted_by: string | null;
      revert_reason: string;
      batch: { batch_number: string; reference: string; created_at: string; created_by: string | null };
    }>,
    tickets: (tickets.data ?? []) as Array<Pick<TicketRow, "id" | "load_id" | "order_line_id" | "ticket_number" | "revision" | "quantity" | "unit_code" | "external_reference"> & { status: TicketStatus }>,
    names,
    people,
    timezone,
  };
}

export type OrderBilling = NonNullable<Awaited<ReturnType<typeof getOrderBilling>>>;

/** The frozen snapshots of a batch (for the handoff file). */
export async function getHandoffBatch(handoffId: string) {
  if (!uuid.safeParse(handoffId).success) return null;
  const supabase = await createClient();
  const { data: batch } = await supabase.from("billing_handoffs").select("*").eq("id", handoffId).maybeSingle();
  if (!batch) return null;
  const { data: items } = await supabase.from("billing_handoff_orders").select("id, order_id, reverted_at, snapshot").eq("handoff_id", handoffId);
  return {
    batch: batch as HandoffBatchRow,
    items: (items ?? []) as Array<{ id: string; order_id: string; reverted_at: string | null; snapshot: HandoffSnapshot }>,
  };
}

/** One order's billing readiness (the same view the billing board uses), or null without billing access. */
export async function getOrderReadiness(orderId: string) {
  if (!uuid.safeParse(orderId).success) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("billing_order_status")
    .select("readiness, status, loads_missing, loads_not_due, tickets_live, tickets_pending, exceptions_count, fulfilled, fulfillment_gap")
    .eq("order_id", orderId)
    .maybeSingle();
  return (data ?? null) as (ReadinessCounts & { readiness: Readiness }) | null;
}
