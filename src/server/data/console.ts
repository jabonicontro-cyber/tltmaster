import "server-only";
import type {
  AuditFacets, AuditFilters, AuditRow, CompanyHealth, ConsoleSearch, Inbox, InboxFilter, MySupportWork, PipelineLead, SecurityOverview,
  SupportRequestDetail, TimelineItem, UsageWeek,
} from "@/lib/platform/console";
import { createClient } from "@/server/supabase/server";

// Platform console reads (PC1, 20261120020100 to 20261120020700). Each goes through one platform_* database function,
// which checks the caller's staff level itself (Admin, or Admin and Support). Before an update is installed the
// function is missing and the page says "not available yet" instead of showing zeros.

export type Loaded<T> = { ok: true; data: T } | { ok: false; reason: "not_installed" | "error"; message: string };

const MISSING = ["PGRST202", "42883", "42P01"];

function failed(error: { code?: string; message: string }, what: string): Loaded<never> {
  if (MISSING.includes(error.code ?? "")) return { ok: false, reason: "not_installed", message: `${what} is not available on this database yet. The rest of the console works as before.` };
  if (error.code === "22023" || error.code === "P0002") return { ok: false, reason: "error", message: error.message };
  console.error("Console read failed", { what, code: error.code });
  return { ok: false, reason: "error", message: `${what} could not be loaded right now. Nothing was changed; try again in a moment.` };
}

async function rpc<T>(fn: string, args: Record<string, unknown> | undefined, what: string): Promise<Loaded<T>> {
  const supabase = await createClient();
  const { data, error } = args ? await supabase.rpc(fn, args) : await supabase.rpc(fn);
  if (error) return failed(error, what);
  return { ok: true, data: data as T };
}

/** Health for every active company, or for one (Admin and Support). */
export async function companyHealth(companyId?: string): Promise<Loaded<{ rows: CompanyHealth[]; now: number }>> {
  const r = await rpc<CompanyHealth[]>("platform_company_health", companyId ? { p_company: companyId } : undefined, "Company health");
  // "Quiet for N days" is measured from the moment the figures were read.
  return r.ok ? { ok: true, data: { rows: r.data, now: Date.now() } } : r;
}

/** The company's timeline, newest first (Admins). */
export async function companyTimeline(companyId: string, before?: string): Promise<Loaded<TimelineItem[]>> {
  return rpc<TimelineItem[]>("platform_company_timeline", { p_company: companyId, p_before: before ?? null, p_limit: 60 }, "The customer timeline");
}

/** Weekly usage, oldest week first (Admin and Support). */
export async function companyUsage(companyId: string, weeks = 8): Promise<Loaded<UsageWeek[]>> {
  return rpc<UsageWeek[]>("platform_company_usage", { p_company: companyId, p_weeks: weeks }, "Usage by week");
}

export async function supportInbox(filter: InboxFilter): Promise<Loaded<Inbox>> {
  return rpc<Inbox>("platform_support_inbox", { p_status: filter }, "The support inbox");
}

export async function supportRequest(id: string): Promise<Loaded<SupportRequestDetail>> {
  return rpc<SupportRequestDetail>("platform_support_request", { p_id: id }, "This support request");
}

export async function mySupportWork(): Promise<Loaded<MySupportWork>> {
  return rpc<MySupportWork>("platform_my_support_work", undefined, "Your visits and change requests");
}

export async function consoleSearch(q: string): Promise<Loaded<ConsoleSearch>> {
  return rpc<ConsoleSearch>("platform_search", { p_q: q }, "Search");
}

export const AUDIT_PAGE = 100;

/** One page of the audit log with these filters, newest first, and whether there is more after it (Admins). */
export async function auditLog(f: AuditFilters): Promise<Loaded<{ rows: AuditRow[]; more: boolean }>> {
  const r = await rpc<AuditRow[]>("platform_audit_search", {
    p_actor: f.actor || null, p_action: f.action || null, p_company: f.company || null, p_from: f.from || null, p_to: f.to || null,
    p_before: f.before ? Number(f.before) : null, p_limit: AUDIT_PAGE + 1,
  }, "The filtered audit log");
  if (!r.ok) return r;
  return { ok: true, data: { rows: r.data.slice(0, AUDIT_PAGE), more: r.data.length > AUDIT_PAGE } };
}

export async function auditFacets(): Promise<Loaded<AuditFacets>> {
  return rpc<AuditFacets>("platform_audit_facets", undefined, "The audit log filters");
}

export async function securityOverview(): Promise<Loaded<SecurityOverview>> {
  return rpc<SecurityOverview>("platform_security_overview", undefined, "The security overview");
}

/** Leads for the pipeline columns: open ones, plus those closed in the last 90 days; never spam (Admins). */
export async function leadPipeline(): Promise<Loaded<PipelineLead[]>> {
  return rpc<PipelineLead[]>("platform_lead_pipeline", undefined, "The lead pipeline");
}
