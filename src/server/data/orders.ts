import "server-only";
import { createClient } from "@/server/supabase/server";
import { ORDER_STATUSES } from "@/lib/orders/status";
import { ilikePattern, PAGE_SIZE } from "./search";
import { getUserNames } from "./quotes";
import type { CustomerRow, OrderLineRow, OrderListRow, OrderRow, OrderStatusEventRow, OrderStatus } from "./types";

export interface OrderFilters {
  q?: string;
  status?: string;
  customer?: string;
  page: number;
}

export async function listOrders(filters: OrderFilters) {
  const supabase = await createClient();
  let query = supabase.from("order_list").select("*", { count: "exact" }).order("created_at", { ascending: false });
  const pattern = ilikePattern(filters.q);
  if (pattern) {
    query = query.or(
      `order_number.ilike.${pattern},customer_name.ilike.${pattern},source_quote_number.ilike.${pattern},project_name.ilike.${pattern},site_label.ilike.${pattern},site_line1.ilike.${pattern},customer_po.ilike.${pattern}`,
    );
  }
  if (filters.status && (ORDER_STATUSES as string[]).includes(filters.status)) query = query.eq("status", filters.status as OrderStatus);
  if (filters.customer) query = query.eq("customer_id", filters.customer);
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

export async function getOrderDetail(id: string) {
  const supabase = await createClient();
  const { data: order, error } = await supabase.from("orders").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load order: ${error.message}`);
  if (!order) return null;
  const o = order as OrderRow;
  const [customer, lines, events, quote, version, names] = await Promise.all([
    supabase.from("customers").select("*").eq("id", o.customer_id).single(),
    supabase.from("order_lines").select("*").eq("order_id", id).order("line_no"),
    supabase.from("order_status_events").select("*").eq("order_id", id).order("occurred_at", { ascending: false }),
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
    // null when the user lacks quotes.view (RLS) — the link is still recorded on the order.
    sourceQuote: quote.data as { id: string; quote_number: string; accepted_at: string | null } | null,
    sourceVersion: version.data as { id: string; version_no: number } | null,
    names,
  };
}
