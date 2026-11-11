import "server-only";
import { CUSTOMER_COLUMNS } from "./customers";
import { allRows as readAllRows } from "@/server/data/all-rows";
import { createClient } from "@/server/supabase/server";
import { referenceKey } from "@/lib/search";
import { idsClause, ilikePattern, PAGE_SIZE, REF_KEYS, referenceMatches } from "./search";
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
import { sortByActivity, type QuoteActivity } from "@/lib/quotes/activity";
import { QUOTE_HISTORY_ACTIONS, type QuoteAuditEntry } from "@/lib/quotes/history";

export interface QuoteFilters {
  q?: string;
  status?: string;
  customer?: string;
  from?: string;
  to?: string;
  page: number;
}

/** Rows per request when the list reads every matching quote's dates (the API returns at most 1000 at a time). */
const CHUNK = 1000;
/** Read every row of a query in chunks of CHUNK (bounded: 50 000 rows). */
async function allRows<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 50 * CHUNK; from += CHUNK) {
    const { data, error } = await read(from, from + CHUNK - 1);
    if (error) throw new Error(`Could not load quotes: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < CHUNK) break;
  }
  return out;
}

/**
 * The Quotes list, most recent activity first (WK1; src/lib/quotes/activity.ts). The activity of a quote comes from
 * three places (its dates in quote_list, its closed date, and the last save of an unsent revision), so the matching
 * quotes' dates are read first, sorted here, and only the page's rows are then read in full.
 */
export async function listQuotes(filters: QuoteFilters) {
  const supabase = await createClient();
  const pattern = ilikePattern(filters.q);
  const refIds = pattern ? await referenceMatches(supabase, REF_KEYS.quotes, referenceKey(filters.q)) : [];
  type Light = Pick<QuoteListRow, "id" | "quote_number" | "status" | "created_at" | "last_sent_at" | "accepted_at">;
  const light = await allRows<Light>((a, b) => {
    let query = supabase.from("quote_list").select("id, quote_number, status, created_at, last_sent_at, accepted_at").order("id").range(a, b);
    if (pattern) query = query.or(`quote_number.ilike.${pattern},customer_name.ilike.${pattern},project_name.ilike.${pattern},site_label.ilike.${pattern},site_line1.ilike.${pattern},site_city.ilike.${pattern}${idsClause(refIds)}`);
    if (filters.status && (QUOTE_STATUSES as readonly string[]).includes(filters.status)) query = query.eq("status", filters.status);
    if (filters.status === "open") query = query.in("status", ["draft", "sent"]);
    if (filters.customer) query = query.eq("customer_id", filters.customer);
    if (filters.from && /^\d{4}-\d{2}-\d{2}$/.test(filters.from)) query = query.gte("quote_date", filters.from);
    if (filters.to && /^\d{4}-\d{2}-\d{2}$/.test(filters.to)) query = query.lte("quote_date", filters.to);
    return query;
  });
  const [closed, edited] = await Promise.all([
    allRows<{ id: string; closed_at: string }>((a, b) => supabase.from("quotes").select("id, closed_at").not("closed_at", "is", null).order("id").range(a, b)),
    allRows<{ quote_id: string; updated_at: string }>((a, b) => supabase.from("quote_versions").select("quote_id, updated_at").is("locked_at", null).order("id").range(a, b)),
  ]);
  const closedAt = new Map(closed.map((c) => [c.id, c.closed_at]));
  const editedAt = new Map<string, string>();
  for (const v of edited) if (!editedAt.has(v.quote_id) || editedAt.get(v.quote_id)! < v.updated_at) editedAt.set(v.quote_id, v.updated_at);
  const sorted = sortByActivity(light.map((q) => ({ ...q, closed_at: closedAt.get(q.id) ?? null, edited_at: editedAt.get(q.id) ?? null })));
  const from = (filters.page - 1) * PAGE_SIZE;
  const page = sorted.slice(from, from + PAGE_SIZE);
  if (!page.length) return { rows: [] as Array<QuoteListRow & { activity: QuoteActivity }>, total: sorted.length };
  const { data, error } = await supabase.from("quote_list").select("*").in("id", page.map((q) => q.id));
  if (error) throw new Error(`Could not load quotes: ${error.message}`);
  const full = new Map(((data ?? []) as QuoteListRow[]).map((r) => [r.id, r]));
  const rows = page.flatMap((q) => (full.has(q.id) ? [{ ...full.get(q.id)!, activity: q.activity }] : []));
  return { rows, total: sorted.length };
}

/**
 * Open quotes at a glance (the Quotes page figures): drafts, sent quotes waiting for an answer with their total, and
 * sent quotes whose validity ends within a week. Read with the person's session (RLS: their company only).
 */
export async function quotePipeline(today: string, weekEnd: string) {
  const supabase = await createClient();
  const { data, error } = await readAllRows(() => supabase.from("quote_list").select("status, total_cents, valid_until").in("status", ["draft", "sent"]).order("id"));
  if (error) return null;
  const rows = (data ?? []) as Array<{ status: string; total_cents: number; valid_until: string }>;
  const sent = rows.filter((r) => r.status === "sent");
  return {
    drafts: rows.length - sent.length,
    sent: sent.length,
    sentCents: sent.reduce((n, r) => n + (r.total_cents ?? 0), 0),
    expiring: sent.filter((r) => r.valid_until >= today && r.valid_until <= weekEnd).length,
  };
}

/**
 * Names for history ("who did this"): the company's people, plus Taviron team members who visited the company, shown
 * as "Name (Taviron support)" (SA1; nothing extra before 20261120008900 is installed). For pickers of people, use
 * getPeopleNames, which has the company's people only.
 */
export async function getUserNames(): Promise<Record<string, string>> {
  const supabase = await createClient();
  const [people, staff] = await Promise.all([getPeopleNames(), supabase.rpc("support_actor_names")]);
  const out: Record<string, string> = { ...people };
  for (const s of (staff.error ? [] : staff.data ?? []) as Array<{ user_id: string; name: string }>) out[s.user_id] ??= s.name;
  return out;
}

/** The company's own people (never Taviron support), for choosing a person. */
export async function getPeopleNames(): Promise<Record<string, string>> {
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

  const [customer, versions, lines, events, deliveries, names, audit] = await Promise.all([
    supabase.from("customers").select(CUSTOMER_COLUMNS).eq("id", q.customer_id).single(),
    supabase.from("quote_versions").select("*").eq("quote_id", id).order("version_no", { ascending: false }),
    supabase.from("quote_lines").select("*").eq("quote_version_id", q.current_version_id).order("line_no"),
    supabase.from("quote_status_events").select("*").eq("quote_id", id).order("occurred_at", { ascending: false }),
    supabase.from("email_deliveries").select("*, documents(filename, sha256, byte_size)").eq("quote_id", id).order("created_at", { ascending: false }),
    getUserNames(),
    // Edits and new revisions for the History (WK1), from the audit log with the person's own session: owners
    // (audit.view), and everyone with quotes.view once 20261120019000 is installed. Nothing (not an error) otherwise.
    supabase.from("audit_events").select("id, occurred_at, actor_id, action, summary, details").eq("entity_type", "quote").eq("entity_id", id)
      .in("action", [...QUOTE_HISTORY_ACTIONS]).order("occurred_at", { ascending: false }).limit(200),
  ]);
  for (const r of [customer, versions, lines, events, deliveries]) {
    if (r.error) throw new Error(`Could not load quote: ${r.error.message}`);
  }
  const allVersions = (versions.data ?? []) as QuoteVersionRow[];
  return {
    quote: q,
    customer: customer.data as unknown as CustomerRow,
    versions: allVersions,
    current: allVersions.find((v) => v.id === q.current_version_id)!,
    lines: (lines.data ?? []) as QuoteLineRow[],
    events: (events.data ?? []) as StatusEventRow[],
    deliveries: (deliveries.data ?? []) as DeliveryRow[],
    names,
    audit: (audit.error ? [] : audit.data ?? []) as QuoteAuditEntry[],
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
  const { data: customer, error } = await supabase.from("customers").select(CUSTOMER_COLUMNS).eq("id", q.customer_id).single();
  if (error) throw new Error("Could not load customer.");
  return {
    quote: q,
    version: version.data as QuoteVersionRow,
    lines: (lines.data ?? []) as QuoteLineRow[],
    customer: customer as unknown as CustomerRow,
  };
}
