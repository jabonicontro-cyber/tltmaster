import "server-only";
import { createClient } from "@/server/supabase/server";
import { addDays } from "@/lib/dates";
import { OPEN_ORDER_STATUSES, ORDER_STATUSES } from "@/lib/orders/status";
import { uuid } from "@/lib/schemas/common";
import { ilikePattern, PAGE_SIZE } from "./search";
import { getUserNames } from "./quotes";
import { businessToday } from "./settings";
import type { AuditEventRow, CustomerRow, OrderLineRow, OrderListRow, OrderRow, OrderStatusEventRow, OrderStatus } from "./types";

export const ORDER_SCHEDULE_FILTERS = {
  today: "Scheduled today",
  week: "Next 7 days",
  unscheduled: "Not scheduled yet",
} as const;
export type OrderScheduleFilter = keyof typeof ORDER_SCHEDULE_FILTERS;

export interface OrderFilters {
  q?: string;
  /** "open", or one order status */
  status?: string;
  customer?: string;
  /** "quote" or "direct" */
  source?: string;
  when?: string;
  page: number;
}

export async function listOrders(filters: OrderFilters) {
  const supabase = await createClient();
  const when = filters.when && filters.when in ORDER_SCHEDULE_FILTERS ? (filters.when as OrderScheduleFilter) : null;
  let query = supabase.from("order_list").select("*", { count: "exact" });
  query =
    when === "today" || when === "week"
      ? query.order("scheduled_start", { ascending: true }).order("window_start", { ascending: true, nullsFirst: false }).order("order_number")
      : query.order("created_at", { ascending: false });
  const pattern = ilikePattern(filters.q);
  if (pattern) {
    query = query.or(
      `order_number.ilike.${pattern},customer_name.ilike.${pattern},source_quote_number.ilike.${pattern},project_name.ilike.${pattern},site_label.ilike.${pattern},site_line1.ilike.${pattern},site_city.ilike.${pattern},customer_po.ilike.${pattern},contact_name.ilike.${pattern},material_summary.ilike.${pattern}`,
    );
  }
  if (filters.status === "open") query = query.in("status", OPEN_ORDER_STATUSES);
  else if (filters.status && (ORDER_STATUSES as string[]).includes(filters.status)) query = query.eq("status", filters.status as OrderStatus);
  if (filters.customer && uuid.safeParse(filters.customer).success) query = query.eq("customer_id", filters.customer);
  if (filters.source === "quote") query = query.not("source_quote_id", "is", null);
  else if (filters.source === "direct") query = query.is("source_quote_id", null);
  if (when) {
    const { today } = await businessToday();
    if (when === "today") {
      query = query.lte("scheduled_start", today).or(`scheduled_end.gte.${today},and(scheduled_end.is.null,scheduled_start.eq.${today})`).neq("status", "canceled");
    } else if (when === "week") {
      query = query.gte("scheduled_start", today).lte("scheduled_start", addDays(today, 6)).neq("status", "canceled");
    } else {
      query = query.is("scheduled_start", null).in("status", OPEN_ORDER_STATUSES);
    }
  }
  const from = (filters.page - 1) * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error(`Could not load orders: ${error.message}`);
  return { rows: (data ?? []) as OrderListRow[], total: count ?? 0 };
}

/** The order created from a quote, if any (null also when the user cannot view orders). */
export async function getOrderForQuote(quoteId: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("orders").select("id, order_number, status").eq("source_quote_id", quoteId).maybeSingle();
  return (data ?? null) as Pick<OrderRow, "id" | "order_number" | "status"> | null;
}

/** Number of orders whose scheduled delivery covers today (canceled excluded). */
export async function countOrdersScheduledToday(): Promise<number | null> {
  const supabase = await createClient();
  const { today } = await businessToday();
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .lte("scheduled_start", today)
    .or(`scheduled_end.gte.${today},and(scheduled_end.is.null,scheduled_start.eq.${today})`)
    .neq("status", "canceled");
  return error ? null : (count ?? 0);
}

export async function getOrderDetail(id: string) {
  if (!uuid.safeParse(id).success) return null;
  const supabase = await createClient();
  const { data: order, error } = await supabase.from("orders").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load order: ${error.message}`);
  if (!order) return null;
  const o = order as OrderRow;
  const [customer, lines, events, audit, quote, version, names] = await Promise.all([
    supabase.from("customers").select("*").eq("id", o.customer_id).single(),
    supabase.from("order_lines").select("*").eq("order_id", id).order("line_no"),
    supabase.from("order_status_events").select("*").eq("order_id", id).order("occurred_at", { ascending: false }),
    supabase.from("audit_events").select("*").eq("entity_type", "order").eq("entity_id", id).order("occurred_at", { ascending: false }).limit(100),
    o.source_quote_id ? supabase.from("quotes").select("id, quote_number, accepted_at").eq("id", o.source_quote_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    o.source_quote_version_id ? supabase.from("quote_versions").select("id, version_no").eq("id", o.source_quote_version_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    getUserNames(),
  ]);
  for (const r of [customer, lines, events]) {
    if (r.error) throw new Error(`Could not load order: ${r.error.message}`);
  }
  return {
    order: o,
    customer: customer.data as CustomerRow,
    lines: (lines.data ?? []) as OrderLineRow[],
    events: (events.data ?? []) as OrderStatusEventRow[],
    // Edits and status changes recorded in the audit log (status changes also appear in events).
    audit: (audit.data ?? []) as AuditEventRow[],
    // null when the user lacks quotes.view (RLS) — the link is still recorded on the order.
    sourceQuote: quote.data as { id: string; quote_number: string; accepted_at: string | null } | null,
    sourceVersion: version.data as { id: string; version_no: number } | null,
    names,
  };
}
