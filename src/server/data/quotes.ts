import "server-only";
import { createClient } from "@/server/supabase/server";
import { ilikePattern, PAGE_SIZE } from "./search";
import type {
  CustomerRow,
  DeliveryRow,
  QuoteLineRow,
  QuoteListRow,
  QuoteRow,
  QuoteVersionRow,
  StatusEventRow,
} from "./types";
import { QUOTE_STATUSES } from "@/lib/quotes/status";

export interface QuoteFilters {
  q?: string;
  status?: string;
  customer?: string;
  from?: string;
  to?: string;
  page: number;
}

export async function listQuotes(filters: QuoteFilters) {
  const supabase = await createClient();
  let query = supabase.from("quote_list").select("*", { count: "exact" }).order("created_at", { ascending: false });
  const pattern = ilikePattern(filters.q);
  if (pattern) {
    query = query.or(`quote_number.ilike.${pattern},customer_name.ilike.${pattern},project_name.ilike.${pattern},site_label.ilike.${pattern},site_line1.ilike.${pattern},site_city.ilike.${pattern}`);
  }
  if (filters.status && (QUOTE_STATUSES as readonly string[]).includes(filters.status)) query = query.eq("status", filters.status);
  if (filters.status === "open") query = query.in("status", ["draft", "sent"]);
  if (filters.customer) query = query.eq("customer_id", filters.customer);
  if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) query = query.gte("quote_date", filters.from);
  if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) query = query.lte("quote_date", filters.to);
  const from = (filters.page - 1) * PAGE_SIZE;
  const { data, error, count } = await query.range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error(`Could not load quotes: ${error.message}`);
  return { rows: (data ?? []) as QuoteListRow[], total: count ?? 0 };
}

export async function getUserNames(): Promise<Record<string, string>> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("user_directory");
  const out: Record<string, string> = {};
  for (const u of (data ?? []) as Array<{ id: string; full_name: string; email: string }>) out[u.id] = u.full_name || u.email;
  return out;
}

export async function getQuoteDetail(id: string) {
  const supabase = await createClient();
  const { data: quote, error } = await supabase.from("quotes").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load quote: ${error.message}`);
  if (!quote) return null;
  const q = quote as QuoteRow;

  const [customer, versions, lines, events, deliveries, names] = await Promise.all([
    supabase.from("customers").select("*").eq("id", q.customer_id).single(),
    supabase.from("quote_versions").select("*").eq("quote_id", id).order("version_no", { ascending: false }),
    supabase.from("quote_lines").select("*").eq("quote_version_id", q.current_version_id).order("line_no"),
    supabase.from("quote_status_events").select("*").eq("quote_id", id).order("occurred_at", { ascending: false }),
    supabase.from("email_deliveries").select("*, documents(filename, sha256, byte_size)").eq("quote_id", id).order("created_at", { ascending: false }),
    getUserNames(),
  ]);
  for (const r of [customer, versions, lines, events, deliveries]) {
    if (r.error) throw new Error(`Could not load quote: ${r.error.message}`);
  }
  const allVersions = (versions.data ?? []) as QuoteVersionRow[];
  return {
    quote: q,
    customer: customer.data as CustomerRow,
    versions: allVersions,
    current: allVersions.find((v) => v.id === q.current_version_id)!,
    lines: (lines.data ?? []) as QuoteLineRow[],
    events: (events.data ?? []) as StatusEventRow[],
    deliveries: (deliveries.data ?? []) as DeliveryRow[],
    names,
  };
}

export async function getQuoteVersion(quoteId: string, versionId: string) {
  const supabase = await createClient();
  const [quote, version, lines] = await Promise.all([
    supabase.from("quotes").select("*").eq("id", quoteId).maybeSingle(),
    supabase.from("quote_versions").select("*").eq("id", versionId).eq("quote_id", quoteId).maybeSingle(),
    supabase.from("quote_lines").select("*").eq("quote_version_id", versionId).order("line_no"),
  ]);
  if (quote.error || version.error || lines.error) throw new Error("Could not load quote version.");
  if (!quote.data || !version.data) return null;
  const q = quote.data as QuoteRow;
  const { data: customer, error } = await supabase.from("customers").select("*").eq("id", q.customer_id).single();
  if (error) throw new Error("Could not load customer.");
  return {
    quote: q,
    version: version.data as QuoteVersionRow,
    lines: (lines.data ?? []) as QuoteLineRow[],
    customer: customer as CustomerRow,
  };
}
