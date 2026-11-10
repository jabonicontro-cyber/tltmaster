import "server-only";
import { createClient } from "@/server/supabase/server";
import { referenceKey } from "@/lib/search";
import { rankRows } from "@/lib/search/rank";
import { idsClause, ilikePattern, PAGE_SIZE, REF_KEYS, referenceMatches } from "./search";
import type { ContactRow, CustomerRow, QuoteListRow, SiteRow } from "./types";

export interface CustomerFilters {
  q?: string;
  type?: string;
  status?: string;
  relationship?: string;
  tag?: string;
  sort?: string;
  page: number;
}

const BASE_COLUMNS = "id, customer_number, name, customer_type, email, phone, billing_city, billing_state, active, is_sample, po_required, updated_at, created_at";
type ListRow = Pick<CustomerRow, "id" | "customer_number" | "name" | "customer_type" | "email" | "phone" | "billing_city" | "billing_state" | "active" | "is_sample" | "po_required" | "updated_at"> & {
  relationship?: "prospect" | "customer";
  tags?: string[];
  account_owner_id?: string | null;
};

/** Customers for the list. With the CRM update (20261119000100) also relationship, tags and owner; without it the
 *  list works as before and the CRM filters are ignored. */
export async function listCustomers(filters: CustomerFilters) {
  const supabase = await createClient();
  const refIds = await referenceMatches(supabase, REF_KEYS.customers, referenceKey(filters.q));
  const run = (crm: boolean) => {
    let query = supabase.from("customers").select(crm ? `${BASE_COLUMNS}, relationship, tags, account_owner_id` : BASE_COLUMNS, { count: "exact" });
    const sort = filters.sort === "newest" ? ["created_at", false] : filters.sort === "number" ? ["customer_number", true] : filters.sort === "updated" ? ["updated_at", false] : ["name", true];
    query = query.order(sort[0] as string, { ascending: sort[1] as boolean });
    const pattern = ilikePattern(filters.q);
    if (pattern) {
      query = query.or(`name.ilike.${pattern},customer_number.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern},billing_city.ilike.${pattern}${idsClause(refIds)}`);
    }
    if (filters.type === "commercial" || filters.type === "residential") query = query.eq("customer_type", filters.type);
    if (filters.status === "archived") query = query.eq("active", false);
    else if (filters.status !== "all") query = query.eq("active", true);
    if (crm && (filters.relationship === "prospect" || filters.relationship === "customer")) query = query.eq("relationship", filters.relationship);
    if (crm && filters.tag) query = query.contains("tags", [filters.tag.slice(0, 40)]);
    const from = (filters.page - 1) * PAGE_SIZE;
    return query.range(from, from + PAGE_SIZE - 1);
  };
  let res = await run(true);
  let crm = true;
  if (res.error?.code === "42703") {
    crm = false;
    res = await run(false);
  }
  if (res.error) throw new Error(`Could not load customers: ${res.error.message}`);
  const rows = (res.data ?? []) as unknown as ListRow[];
  // With a search and the default sort, the best matches come first (name before number, email, phone or city).
  const ranked = !filters.sort || filters.sort === "name"
    ? rankRows(rows, filters.q, (r) => ({ main: r.name, others: [r.customer_number, r.email, r.phone, r.billing_city] }))
    : rows;
  return { rows: ranked, total: res.count ?? 0, crm };
}

/**
 * Every customer column people may read (financial review L1, 20261120016200): never select("*"), which the database
 * refuses since the credit limit and detention rate are billing data. Those come from customerMoneyTerms (billing.view).
 */
export const CUSTOMER_COLUMNS =
  "id, customer_number, name, customer_type, email, phone, billing_line1, billing_line2, billing_city, billing_state, billing_postal_code, " +
  "po_required, po_instructions, payment_terms, price_list_id, tax_exempt, notes, active, is_sample, created_at, updated_at, " +
  "relationship, account_owner_id, tags, is_priority, credit_hold, credit_hold_reason, credit_hold_at, credit_hold_by, " +
  "detention_free_minutes, is_broker, mc_number";

export async function getCustomer(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("customers").select(CUSTOMER_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load customer: ${error.message}`);
  return data as unknown as CustomerRow | null;
}

export interface CustomerMoneyTerms {
  creditLimitCents: number | null;
  detentionFreeMinutes: number | null;
  detentionRateCents: number | null;
}

/**
 * A customer's credit limit and detention charge, for people with billing.view only (public.customer_money_terms,
 * 20261120016200). Null for everyone else, and when the update is not installed.
 */
export async function customerMoneyTerms(customerId: string): Promise<CustomerMoneyTerms | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("customer_money_terms", { p_customers: [customerId] });
  if (error) return null;
  const row = ((data ?? []) as Array<{ customer_id: string; credit_limit_cents: number | string | null; detention_free_minutes: number | null; detention_rate_cents: number | null }>)
    .find((r) => r.customer_id === customerId);
  if (!row) return null;
  return {
    creditLimitCents: row.credit_limit_cents === null ? null : Number(row.credit_limit_cents),
    detentionFreeMinutes: row.detention_free_minutes,
    detentionRateCents: row.detention_rate_cents,
  };
}

export async function getCustomerDetail(id: string) {
  const supabase = await createClient();
  const [customer, contacts, sites, quotes] = await Promise.all([
    supabase.from("customers").select(`${CUSTOMER_COLUMNS}, price_lists(name)`).eq("id", id).maybeSingle(),
    supabase.from("customer_contacts").select("*").eq("customer_id", id).order("active", { ascending: false }).order("is_primary", { ascending: false }).order("name"),
    supabase.from("customer_sites").select("*").eq("customer_id", id).order("active", { ascending: false }).order("label"),
    supabase.from("quote_list").select("*").eq("customer_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  for (const r of [customer, contacts, sites]) {
    if (r.error) throw new Error(`Could not load customer: ${r.error.message}`);
  }
  if (!customer.data) return null;
  return {
    customer: customer.data as unknown as CustomerRow & { price_lists: { name: string } | null },
    contacts: (contacts.data ?? []) as ContactRow[],
    sites: (sites.data ?? []) as SiteRow[],
    // Users without quotes.view simply get no rows (RLS).
    quotes: (quotes.data ?? []) as QuoteListRow[],
  };
}

export async function listCustomerOptions() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, name, customer_number, customer_type, is_sample, tax_exempt, active")
    .eq("active", true)
    .order("name")
    .limit(2000);
  if (error) throw new Error(`Could not load customers: ${error.message}`);
  return (data ?? []) as Array<Pick<CustomerRow, "id" | "name" | "customer_number" | "customer_type" | "is_sample" | "tax_exempt" | "active">>;
}

export async function getCustomerQuoteContext(customerId: string) {
  const supabase = await createClient();
  const [customer, contacts, sites] = await Promise.all([
    supabase.from("customers").select("id, name, customer_number, tax_exempt, po_required, po_instructions, payment_terms, is_sample, active").eq("id", customerId).maybeSingle(),
    supabase.from("customer_contacts").select("*").eq("customer_id", customerId).eq("active", true).order("is_primary", { ascending: false }).order("name"),
    supabase.from("customer_sites").select("*").eq("customer_id", customerId).eq("active", true).order("label"),
  ]);
  if (customer.error || contacts.error || sites.error) throw new Error("Could not load customer details.");
  if (!customer.data) return null;
  return {
    customer: customer.data as Pick<CustomerRow, "id" | "name" | "customer_number" | "tax_exempt" | "po_required" | "po_instructions" | "payment_terms" | "is_sample" | "active">,
    contacts: (contacts.data ?? []) as ContactRow[],
    sites: (sites.data ?? []) as SiteRow[],
  };
}
