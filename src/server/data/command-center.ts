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
  const { data, error } = await supabase.rpc("command_center_summary");
  if (error || !data) return { ok: false, error: "The overview could not be loaded." };
  return { ok: true, data: data as CommandSummary };
}

export interface QueuePage {
  total: number;
  limit: number;
  offset: number;
  items: ExceptionItem[];
}

/** One bounded page of the prioritized attention queue. */
export async function loadQueue(f: { kind?: ExceptionKind; mine?: boolean; page: number }): Promise<Loaded<QueuePage>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("command_center_exceptions", {
    p_kind: f.kind ?? null,
    p_mine: f.mine ?? false,
    p_limit: QUEUE_PAGE_SIZE,
    p_offset: (f.page - 1) * QUEUE_PAGE_SIZE,
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

/**
 * Recent operational activity from the audit log, as the caller's RLS allows
 * (order entries with orders.view — billing ones only with billing.view —,
 * fleet entries with fleet.view, everything with audit.view). Bounded and paged.
 */
export async function loadActivity(access: Access, page: number): Promise<Loaded<{ rows: ActivityRow[]; hasMore: boolean }>> {
  const supabase = await createClient();
  const types = ["order", "truck", "trailer", "driver", "driver_qualification"];
  let q = supabase
    .from("audit_events")
    .select("id, occurred_at, actor_id, action, entity_type, entity_id, summary")
    .in("entity_type", types)
    .order("occurred_at", { ascending: false })
    .range((page - 1) * ACTIVITY_PAGE_SIZE, page * ACTIVITY_PAGE_SIZE); // one extra row tells whether there is more
  if (!can(access, "billing.view")) q = q.not("action", "like", "billing.*");
  const { data, error } = await q;
  if (error) return { ok: false, error: "Recent activity could not be loaded." };
  const rows = (data ?? []) as ActivityRow[];
  return { ok: true, data: { rows: rows.slice(0, ACTIVITY_PAGE_SIZE), hasMore: rows.length > ACTIVITY_PAGE_SIZE } };
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
