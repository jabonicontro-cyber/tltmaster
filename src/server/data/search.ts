import "server-only";
import type { createClient } from "@/server/supabase/server";

/** Make user search text safe inside a PostgREST or=(...) ilike filter. */
export function ilikePattern(q: string | undefined | null): string | null {
  const cleaned = (q ?? "").replace(/[,()%*\\"'.:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned ? `%${cleaned}%` : null;
}

export const PAGE_SIZE = 25;

export function pageParam(value: string | undefined): number {
  const n = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : 1;
}

type RefTable = { table: "orders" | "quotes" | "delivery_tickets" | "customers" | "billing_handoffs" | "work_orders"; column: string };
export const REF_KEYS = {
  orders: { table: "orders", column: "order_ref_key" },
  quotes: { table: "quotes", column: "quote_ref_key" },
  tickets: { table: "delivery_tickets", column: "ticket_ref_key" },
  customers: { table: "customers", column: "customer_ref_key" },
  billing: { table: "billing_handoffs", column: "batch_ref_key" },
  workOrders: { table: "work_orders", column: "work_order_ref_key" },
} satisfies Record<string, RefTable>;

/**
 * Ids of records whose reference matches a typed reference however it was formatted (migration 20261120001300).
 * Runs with the caller's session, so row-level security still decides what is visible; returns [] before the migration.
 */
export async function referenceMatches(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ref: RefTable,
  key: string | null,
): Promise<string[]> {
  if (!key) return [];
  const { data, error } = await supabase.from(ref.table).select("id").ilike(ref.column, `%${key}%`).limit(50);
  if (error || !data) return [];
  return (data as Array<{ id: string }>).map((r) => r.id);
}

/** An extra `or` clause matching those ids (empty when none). Ids are UUIDs from the database, never user text. */
export function idsClause(ids: string[]): string {
  return ids.length ? `,id.in.(${ids.join(",")})` : "";
}
