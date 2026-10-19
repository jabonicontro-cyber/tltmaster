import "server-only";
import { createClient } from "@/server/supabase/server";
import { ilikePattern, PAGE_SIZE } from "./search";
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
  const run = (crm: boolean) => {
    let query = supabase.from("customers").select(crm ? `${BASE_COLUMNS}, relationship, tags, account_owner_id` : BASE_COLUMNS, { count: "exact" });
    const sort = filters.sort === "newest" ? ["created_at", false] : filters.sort === "number" ? ["customer_number", true] : filters.sort === "updated" ? ["updated_at", false] : ["name", true];
    query = query.order(sort[0] as string, { ascending: sort[1] as boolean });
    const pattern = ilikePattern(filters.q);
    if (pattern) {
      query = query.or(`name.ilike.${pattern},customer_number.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern},billing_city.ilike.${pattern}`);
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
  return { rows: (res.data ?? []) as unknown as ListRow[], total: res.count ?? 0, crm };
}

export async function getCustomer(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("customers").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load customer: ${error.message}`);
  return data as CustomerRow | null;
}

export async function getCustomerDetail(id: string) {
  const supabase = await createClient();
  const [customer, contacts, sites, quotes] = await Promise.all([
    supabase.from("customers").select("*, price_lists(name)").eq("id", id).maybeSingle(),
    supabase.from("customer_contacts").select("*").eq("customer_id", id).order("active", { ascending: false }).order("is_primary", { ascending: false }).order("name"),
    supabase.from("customer_sites").select("*").eq("customer_id", id).order("active", { ascending: false }).order("label"),
    supabase.from("quote_list").select("*").eq("customer_id", id).order("created_at", { ascending: false }).limit(50),
  ]);
  for (const r of [customer, contacts, sites]) {
    if (r.error) throw new Error(`Could not load customer: ${r.error.message}`);
  }
  if (!customer.data) return null;
  return {
    customer: customer.data as CustomerRow & { price_lists: { name: string } | null },
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
