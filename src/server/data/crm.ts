import "server-only";
import type { Activity, CrmTask, CustomerHistory, Opportunity } from "@/lib/crm/labels";
import { createClient } from "@/server/supabase/server";

// Company CRM reads (20261119000100). Everything runs as the signed-in person, so RLS decides what is visible.
// Before that update is installed every loader returns null and the pages say so.

const MISSING = new Set(["42P01", "PGRST205", "PGRST202", "42703", "PGRST204"]);

export async function loadCustomerCrm(customerId: string) {
  const supabase = await createClient();
  const [acts, tasks, opps, history] = await Promise.all([
    supabase.from("customer_activities").select("id, kind, occurred_at, subject, body, created_by, contact_id").eq("customer_id", customerId).order("occurred_at", { ascending: false }).limit(50),
    supabase.from("customer_tasks").select("id, customer_id, opportunity_id, title, notes, due_on, assigned_to, status, completed_at, created_at").eq("customer_id", customerId).order("status").order("due_on", { ascending: true, nullsFirst: false }).limit(50),
    supabase.from("crm_opportunities").select("*").eq("customer_id", customerId).order("closed_at", { ascending: false, nullsFirst: true }).order("created_at", { ascending: false }),
    supabase.rpc("customer_history", { p_customer: customerId }),
  ]);
  if ([acts, tasks, opps, history].some((r) => r.error && MISSING.has(r.error.code ?? ""))) return null;
  for (const r of [acts, tasks, opps, history]) if (r.error) throw new Error(`Could not load the customer's CRM records: ${r.error.message}`);
  return {
    activities: (acts.data ?? []) as Activity[],
    tasks: (tasks.data ?? []) as CrmTask[],
    opportunities: (opps.data ?? []) as Opportunity[],
    history: history.data as CustomerHistory,
  };
}

/** The pipeline and the follow-ups of the next week (open tasks, opportunity follow-up dates). */
export async function loadPipeline(today: string, inAWeek: string) {
  const supabase = await createClient();
  const [opps, tasks, prospects] = await Promise.all([
    supabase.from("crm_opportunities").select("*, customers(name, customer_number)").or(`closed_at.is.null,closed_at.gte.${today}T00:00:00Z`).order("follow_up_on", { ascending: true, nullsFirst: false }).limit(1000),
    supabase.from("customer_tasks").select("id, customer_id, opportunity_id, title, notes, due_on, assigned_to, status, completed_at, created_at, customers(name)").eq("status", "open").not("due_on", "is", null).lte("due_on", inAWeek).order("due_on", { ascending: true, nullsFirst: false }).limit(200),
    supabase.from("customers").select("id", { count: "exact", head: true }).eq("relationship", "prospect").eq("active", true),
  ]);
  if ([opps, tasks, prospects].some((r) => r.error && MISSING.has(r.error.code ?? ""))) return null;
  for (const r of [opps, tasks, prospects]) if (r.error) throw new Error(`Could not load the pipeline: ${r.error.message}`);
  return { opportunities: (opps.data ?? []) as unknown as Opportunity[], tasks: (tasks.data ?? []) as unknown as CrmTask[], prospects: prospects.count ?? 0 };
}

export async function findDuplicates(name: string, email: string, phone: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("customer_duplicates", { p_name: name, p_email: email, p_phone: phone });
  if (error) return [];
  return (data ?? []) as Array<{ id: string; customer_number: string; name: string; relationship: string; active: boolean; matched_on: "name" | "email" | "phone" }>;
}
