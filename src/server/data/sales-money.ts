import "server-only";
import { canSeeSalesTotals } from "@/lib/permissions";
import { getAccess } from "@/server/auth";
import { createClient } from "@/server/supabase/server";
import type { AuditEventRow } from "./types";
import { redactHistoryEntry } from "@/lib/orders/money-history";

// Order and quote totals for money access only (owner decision 2026-11-17, master plan §12 SEC7; migration
// 20261120024700). The tables give everyone the per-unit rates but not the totals or line amounts; these read them
// through the database's own checks (order_totals and the like: billing or pricing access), and only when the person,
// as the app shows them (a demo role preview included), may see them. A person without that access gets null: the
// pages then show the rates and leave the totals out.

/** Every orders column a person may read (the totals are read with orderTotals). */
export const ORDER_COLUMNS =
  "id, order_number, customer_id, status, source_quote_id, source_quote_version_id, bill_to_snapshot, contact_name, contact_email, contact_phone, site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code, project_name, customer_po, job_instructions, terms, internal_notes, tax_rate_bp, status_note, is_sample, created_by, created_at, updated_at, company_id, contact_id, order_date, requested_date, scheduled_start, scheduled_end, window_start, window_end, scheduling_notes, edit_seq, confirmed_at, completed_at, canceled_at, updated_by, base_id, order_ref_key, pickup_location_id, job_type, truck_billing, price_check_requested_at, price_check_requested_by, price_check_fingerprint, price_checked_at, price_checked_by, price_check_note";
/** Every order_lines column a person may read (the line amount is read with orderLineAmounts). */
export const ORDER_LINE_COLUMNS =
  "id, order_id, line_no, source_quote_line_id, kind, calc_method, material_id, charge_item_id, description, unit_code, unit_label, quantity, unit_rate_cents, percent_bp, catalog_rate_cents, catalog_percent_bp, price_source, taxable, company_id, price_entered_by";
/** Every quote_versions column a person may read (the totals are read with quoteTotals). */
export const QUOTE_VERSION_COLUMNS =
  "id, quote_id, version_no, edit_seq, contact_id, contact_name, contact_email, contact_phone, site_id, site_label, site_line1, site_line2, site_city, site_state, site_postal_code, quote_date, valid_until, project_name, customer_po, job_instructions, terms, internal_notes, tax_rate_bp, revision_reason, locked_at, locked_by, sent_at, bill_to_snapshot, company_snapshot, created_by, created_at, updated_at, company_id";
/** Every quote_lines column a person may read (the line amount is read with quoteLineAmounts). */
export const QUOTE_LINE_COLUMNS =
  "id, quote_version_id, line_no, kind, calc_method, material_id, charge_item_id, description, unit_code, unit_label, quantity, unit_rate_cents, percent_bp, catalog_rate_cents, catalog_percent_bp, price_source, taxable, company_id";

export interface SalesTotals {
  subtotal_cents: number;
  discount_cents: number;
  taxable_cents: number;
  tax_cents: number;
  total_cents: number;
}

const EMPTY_TOTALS = { subtotal_cents: null, discount_cents: null, taxable_cents: null, tax_cents: null, total_cents: null };

/** Whether the signed-in person, as the app shows them, sees sales totals. */
export async function seesSalesTotals(): Promise<boolean> {
  return canSeeSalesTotals(await getAccess());
}

type Totals = { subtotal_cents: number | string; discount_cents: number | string; taxable_cents: number | string; tax_cents: number | string; total_cents: number | string };
const totalsOf = (r: Totals): SalesTotals => ({
  subtotal_cents: Number(r.subtotal_cents), discount_cents: Number(r.discount_cents), taxable_cents: Number(r.taxable_cents),
  tax_cents: Number(r.tax_cents), total_cents: Number(r.total_cents),
});

/** Order totals by order id, or null when the person may not see them (or they could not be read). */
export async function orderTotals(orderIds: string[]): Promise<Map<string, SalesTotals> | null> {
  if (!(await seesSalesTotals())) return null;
  if (!orderIds.length) return new Map();
  const { data, error } = await (await createClient()).rpc("order_totals", { p_orders: orderIds });
  if (error) return null;
  return new Map(((data ?? []) as Array<Totals & { order_id: string }>).map((r) => [r.order_id, totalsOf(r)]));
}

/** Line amounts by order line id, or null when the person may not see them. */
export async function orderLineAmounts(orderIds: string[]): Promise<Map<string, number> | null> {
  if (!(await seesSalesTotals())) return null;
  if (!orderIds.length) return new Map();
  const { data, error } = await (await createClient()).rpc("order_line_amounts", { p_orders: orderIds });
  if (error) return null;
  return new Map(((data ?? []) as Array<{ line_id: string; amount_cents: number | string }>).map((r) => [r.line_id, Number(r.amount_cents)]));
}

/** Quote version totals by version id, or null when the person may not see them. */
export async function quoteTotals(versionIds: string[]): Promise<Map<string, SalesTotals> | null> {
  if (!(await seesSalesTotals())) return null;
  if (!versionIds.length) return new Map();
  const { data, error } = await (await createClient()).rpc("quote_totals", { p_versions: versionIds });
  if (error) return null;
  return new Map(((data ?? []) as Array<Totals & { version_id: string }>).map((r) => [r.version_id, totalsOf(r)]));
}

/** Quote line amounts by line id, or null when the person may not see them. */
export async function quoteLineAmounts(versionIds: string[]): Promise<Map<string, number> | null> {
  if (!(await seesSalesTotals())) return null;
  if (!versionIds.length) return new Map();
  const { data, error } = await (await createClient()).rpc("quote_line_amounts", { p_versions: versionIds });
  if (error) return null;
  return new Map(((data ?? []) as Array<{ line_id: string; amount_cents: number | string }>).map((r) => [r.line_id, Number(r.amount_cents)]));
}

/** An order or quote row with its totals filled in (null totals when the person may not see them). */
export function withTotals<T extends { id: string }>(row: T, totals: Map<string, SalesTotals> | null): T & SalesTotalsOrNull {
  return { ...row, ...(totals?.get(row.id) ?? EMPTY_TOTALS) };
}
export type SalesTotalsOrNull = { [K in keyof SalesTotals]: number | null };

/** Lines with their amounts filled in (null when the person may not see them). */
export function withAmounts<T extends { id: string }>(rows: T[], amounts: Map<string, number> | null): Array<T & { amount_cents: number | null }> {
  return rows.map((r) => ({ ...r, amount_cents: amounts?.get(r.id) ?? null }));
}

/**
 * The history of one order or quote (newest first, at most 100): through sales_history, which takes the totals out for
 * people without money access. The database decides that by the person's real permissions; a demo role preview without
 * money access gets the redacted copy too (the app strips the totals from the summary itself in that case).
 */
export async function salesHistory(entityType: "order" | "quote", entityId: string): Promise<AuditEventRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("sales_history", { p_entity_type: entityType, p_entity_id: entityId });
  let rows = (data ?? []) as AuditEventRow[];
  if (error) {
    // Before migration 20261120024700: the history straight from the table, as before.
    const direct = await supabase.from("audit_events").select("id, occurred_at, actor_id, action, entity_type, entity_id, summary, details")
      .eq("entity_type", entityType).eq("entity_id", entityId).order("occurred_at", { ascending: false }).limit(100);
    rows = (direct.data ?? []) as AuditEventRow[];
  }
  if (await seesSalesTotals()) return rows;
  return rows.map(redactHistoryEntry);
}
