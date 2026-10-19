import "server-only";
import type { CommandSummary, ExceptionItem, ExceptionKind } from "@/lib/command-center/rules";
import type { Access } from "@/lib/permissions";
import { can } from "@/lib/permissions";
import { createClient } from "@/server/supabase/server";

/** A section's data, or the reason it could not be loaded (never a fake empty result). */
export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };

export const QUEUE_PAGE_SIZE = 20;
export const ACTIVITY_PAGE_SIZE = 15;

/** Counts computed in the database for the caller's company and permissions. */
export async function loadSummary(): Promise<Loaded<CommandSummary>> {
  const supabase = await createClient();
  // Urgent items per kind (20261119000200): the parts of the urgent total, so nothing is counted twice. Without that
  // update the strip shows the total only.
  const [{ data, error }, byKind] = await Promise.all([supabase.rpc("command_center_summary"), supabase.rpc("command_center_urgent_by_kind")]);
  if (error || !data) return { ok: false, error: "The overview could not be loaded." };
  return { ok: true, data: { ...(data as CommandSummary), urgent_by_kind: byKind.error ? null : (byKind.data as Record<string, number>) } };
}

export interface QueuePage {
  total: number;
  /** Items the caller hid from their own view (still open, still counted). */
  hidden: number;
  limit: number;
  offset: number;
  items: ExceptionItem[];
}

/** One bounded page of the prioritized attention queue. */
export async function loadQueue(f: { kind?: ExceptionKind; mine?: boolean; page: number; hidden?: boolean; limit?: number }): Promise<Loaded<QueuePage>> {
  const supabase = await createClient();
  const limit = f.limit ?? QUEUE_PAGE_SIZE;
  const { data, error } = await supabase.rpc("command_center_exceptions", {
    p_kind: f.kind ?? null,
    p_mine: f.mine ?? false,
    p_limit: limit,
    p_offset: (f.page - 1) * limit,
    p_hidden: f.hidden ?? false,
  });
  if (error || !data) return { ok: false, error: "The attention queue could not be loaded." };
  return { ok: true, data: data as QueuePage };
}

export interface ActivityRow {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
}

const OPERATIONS_TYPES = ["order", "truck", "trailer", "driver", "driver_qualification"];
const MAX_ACTIVITY_PAGE = 20;

/**
 * One activity feed for the Command Center, bounded and paged. With audit.view:
 * the company's whole audit log. Otherwise: operational entries the caller's RLS
 * allows (orders with orders.view — billing ones only with billing.view —, fleet
 * with fleet.view) merged with quote status changes when the caller has
 * quotes.view. Nothing is shown that the caller could not open elsewhere.
 */
export async function loadActivity(access: Access, page: number): Promise<Loaded<{ rows: ActivityRow[]; hasMore: boolean }>> {
  const supabase = await createClient();
  const p = Math.min(Math.max(page, 1), MAX_ACTIVITY_PAGE);
  const upto = p * ACTIVITY_PAGE_SIZE + 1; // one extra row tells whether there is more
  const fullAudit = can(access, "audit.view");
  let audit = supabase
    .from("audit_events")
    .select("id, occurred_at, actor_id, action, entity_type, entity_id, summary")
    .order("occurred_at", { ascending: false })
    .limit(upto);
  if (!fullAudit) {
    audit = audit.in("entity_type", OPERATIONS_TYPES);
    if (!can(access, "billing.view")) audit = audit.not("action", "like", "billing.*");
  }
  const quotes = !fullAudit && can(access, "quotes.view")
    ? supabase.from("quote_status_events").select("id, occurred_at, actor_id, quote_id, to_status, note, quotes(quote_number)").order("occurred_at", { ascending: false }).limit(upto)
    : null;
  const [a, q] = await Promise.all([audit, quotes]);
  if (a.error || q?.error) return { ok: false, error: "Recent activity could not be loaded." };
  const quoteRows: ActivityRow[] = ((q?.data ?? []) as unknown as Array<{ id: string; occurred_at: string; actor_id: string | null; quote_id: string; to_status: string; note: string; quotes: { quote_number: string } | null }>).map((e) => ({
    id: `q:${e.id}`,
    occurred_at: e.occurred_at,
    actor_id: e.actor_id,
    action: `quote.${e.to_status}`,
    entity_type: "quote",
    entity_id: e.quote_id,
    summary: `${e.quotes?.quote_number ?? "Quote"} → ${e.to_status}${e.note ? `: ${e.note}` : ""}`,
  }));
  const merged = [...((a.data ?? []) as ActivityRow[]), ...quoteRows].sort((x, y) => (x.occurred_at < y.occurred_at ? 1 : x.occurred_at > y.occurred_at ? -1 : 0));
  const from = (p - 1) * ACTIVITY_PAGE_SIZE;
  return { ok: true, data: { rows: merged.slice(from, from + ACTIVITY_PAGE_SIZE), hasMore: merged.length > p * ACTIVITY_PAGE_SIZE && p < MAX_ACTIVITY_PAGE } };
}

/** The caller's own Command Center layout in the current company (null = defaults). */
export async function loadLayout(): Promise<{ order: string[]; collapsed: string[] } | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("user_preferences").select("value").eq("key", "command_center").maybeSingle();
  const v = (data?.value ?? null) as { order?: unknown; collapsed?: unknown } | null;
  if (!v) return null;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string").slice(0, 20) : []);
  return { order: strings(v.order), collapsed: strings(v.collapsed) };
}

export interface AssigneeOption {
  user_id: string;
  name: string;
  role: string;
  kinds: ExceptionKind[];
}

export async function loadAssigneeOptions(): Promise<AssigneeOption[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("exception_assignee_options");
  return (data ?? []) as AssigneeOption[];
}
