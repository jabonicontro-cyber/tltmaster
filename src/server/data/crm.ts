import "server-only";
import type { Activity, CrmTask, CustomerHistory, Opportunity } from "@/lib/crm/labels";
import { createClient } from "@/server/supabase/server";
import { seesSalesTotals } from "./sales-money";

// Company CRM reads (20261119000100). Everything runs as the signed-in person, so RLS decides what is visible.
// Before that update is installed every loader returns null and the pages say so.

const MISSING = new Set(["42P01", "PGRST205", "PGRST202", "42703", "PGRST204"]);

// Opportunity values are for money access only (owner decision 2026-11-18; 20261120024700): every other column is read
// here, the values through crm_opportunity_values, and only when the person (as the app shows them) may see them.
const OPP_COLUMNS = "id, company_id, customer_id, title, stage, probability, expected_close_on, owner_id, next_action, follow_up_on, quote_id, lost_reason, closed_at, created_by, created_at, updated_at";

/** The opportunities with their values filled in (null when the person may not see them, or they could not be read). */
async function withValues<T extends { id: string }>(rows: T[]): Promise<{ rows: Array<T & { value_cents: number | null }>; showValues: boolean }> {
  const showValues = await seesSalesTotals();
  if (!showValues || !rows.length) return { rows: rows.map((r) => ({ ...r, value_cents: null })), showValues };
  const { data, error } = await (await createClient()).rpc("crm_opportunity_values", { p_ids: rows.map((r) => r.id) });
  const values = new Map(((error ? [] : data ?? []) as Array<{ opportunity_id: string; value_cents: number | string | null }>).map((v) => [v.opportunity_id, v.value_cents === null ? null : Number(v.value_cents)]));
  return { rows: rows.map((r) => ({ ...r, value_cents: values.get(r.id) ?? null })), showValues: !error };
}

export async function loadCustomerCrm(customerId: string) {
  const supabase = await createClient();
  const [acts, tasks, opps, history] = await Promise.all([
    supabase.from("customer_activities").select("id, kind, occurred_at, subject, body, created_by, contact_id").eq("customer_id", customerId).order("occurred_at", { ascending: false }).limit(50),
    supabase.from("customer_tasks").select("id, customer_id, opportunity_id, title, notes, due_on, assigned_to, status, completed_at, created_at").eq("customer_id", customerId).order("status").order("due_on", { ascending: true, nullsFirst: false }).limit(50),
    supabase.from("crm_opportunities").select(OPP_COLUMNS).eq("customer_id", customerId).order("closed_at", { ascending: false, nullsFirst: true }).order("created_at", { ascending: false }),
    supabase.rpc("customer_history", { p_customer: customerId }),
  ]);
  if ([acts, tasks, opps, history].some((r) => r.error && MISSING.has(r.error.code ?? ""))) return null;
  for (const r of [acts, tasks, opps, history]) if (r.error) throw new Error(`Could not load the customer's CRM records: ${r.error.message}`);
  return {
    activities: (acts.data ?? []) as Activity[],
    tasks: (tasks.data ?? []) as CrmTask[],
    ...(await withValues((opps.data ?? []) as unknown as Array<Omit<Opportunity, "value_cents">>).then((v) => ({ opportunities: v.rows as Opportunity[], showValues: v.showValues }))),
    // Order totals only for billing or pricing access (SEC7): the database leaves them out for others; a demo role
    // preview without that access gets them taken out here.
    history: (await seesSalesTotals()) ? (history.data as CustomerHistory) : withoutTotals(history.data as CustomerHistory),
  };
}

function withoutTotals(h: CustomerHistory): CustomerHistory {
  return { ...h, ordered_cents_365d: null, recent_orders: h.recent_orders.map((o) => ({ ...o, total_cents: null })) };
}

/** The pipeline and the follow-ups of the next week (open tasks, opportunity follow-up dates). */
export async function loadPipeline(today: string, inAWeek: string) {
  const supabase = await createClient();
  const [opps, tasks, prospects] = await Promise.all([
    supabase.from("crm_opportunities").select(`${OPP_COLUMNS}, customers(name, customer_number)`).or(`closed_at.is.null,closed_at.gte.${today}T00:00:00Z`).order("follow_up_on", { ascending: true, nullsFirst: false }).limit(1000),
    supabase.from("customer_tasks").select("id, customer_id, opportunity_id, title, notes, due_on, assigned_to, status, completed_at, created_at, customers(name)").eq("status", "open").not("due_on", "is", null).lte("due_on", inAWeek).order("due_on", { ascending: true, nullsFirst: false }).limit(200),
    supabase.from("customers").select("id", { count: "exact", head: true }).eq("relationship", "prospect").eq("active", true),
  ]);
  if ([opps, tasks, prospects].some((r) => r.error && MISSING.has(r.error.code ?? ""))) return null;
  for (const r of [opps, tasks, prospects]) if (r.error) throw new Error(`Could not load the pipeline: ${r.error.message}`);
  const valued = await withValues((opps.data ?? []) as unknown as Array<Omit<Opportunity, "value_cents">>);
  return { opportunities: valued.rows as Opportunity[], showValues: valued.showValues, tasks: (tasks.data ?? []) as unknown as CrmTask[], prospects: prospects.count ?? 0 };
}

export async function findDuplicates(name: string, email: string, phone: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("customer_duplicates", { p_name: name, p_email: email, p_phone: phone });
  if (error) return [];
  return (data ?? []) as Array<{ id: string; customer_number: string; name: string; relationship: string; active: boolean; matched_on: "name" | "email" | "phone" }>;
}
