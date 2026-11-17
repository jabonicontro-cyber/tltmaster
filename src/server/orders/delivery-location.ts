import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Whether an order has a delivery location, by the same rule public.set_order_status uses before "Scheduled"
 * (20261120024110): a job-site address, a site name, or a current delivery stop. Read with the person's own session.
 * Used before saving a schedule that is followed by "Mark scheduled", so a refused status change never leaves a
 * half-applied schedule behind (walkthrough finding D9). Null when the order cannot be read (the database decides).
 */
export async function orderHasDeliveryLocation(supabase: SupabaseClient, orderId: string): Promise<{ has: boolean; orderNumber: string } | null> {
  const [order, stops] = await Promise.all([
    supabase.from("orders").select("order_number, site_line1, site_label").eq("id", orderId).maybeSingle(),
    supabase.from("order_stops").select("id").eq("order_id", orderId).eq("kind", "delivery").is("removed_at", null).limit(1),
  ]);
  const o = order.data as { order_number: string; site_line1: string | null; site_label: string | null } | null;
  if (order.error || !o) return null;
  const site = (o.site_line1 ?? "").trim() || (o.site_label ?? "").trim();
  // Stops not installed (or not readable): only the order's own site counts, as before 20261120024110.
  const stop = !stops.error && (stops.data ?? []).length > 0;
  return { has: Boolean(site) || stop, orderNumber: o.order_number };
}

export const deliveryLocationMessage = (orderNumber: string) =>
  `Add the delivery location to order ${orderNumber} before scheduling it: a job-site address, a site name such as "Customer pickup at the yard", or a delivery stop. Nothing was saved.`;
