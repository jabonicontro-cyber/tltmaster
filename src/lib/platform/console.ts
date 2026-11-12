// Platform console (PC1, 20261120020100 to 20261120020700): the shapes of the console's reads and how they are named.
// The database decides every figure; this file only words them. Missing data is said to be missing, never guessed.
import { formatDate } from "@/lib/dates";
import { activityText } from "./launchpad";
import { LEAD_STATUS_LABELS, leadEventDetail, leadEventText, type LeadStatus } from "./leads";

/** One stage per company (private.company_stage), in words. */
export const STAGE_LABELS: Record<string, string> = {
  fee_due: "Onboarding fee due",
  onboarding: "Onboarding",
  live: "Live",
  canceled: "Canceled",
  demo: "Demo",
  archived: "Archived",
  not_set_up: "Subscription not set up",
};
export function stageLabel(stage: string | null | undefined): string {
  return stage ? STAGE_LABELS[stage] ?? stage.replace(/_/g, " ") : "Not known";
}

// ---------------------------------------------------------------------------------------------------------------------
// Company health (platform_company_health)

export interface CompanyHealth {
  company_id: string;
  name: string;
  is_demo: boolean;
  active: boolean;
  stage: string;
  created_at: string;
  members: number;
  last_sign_in_at: string | null;
  active_7d: number;
  active_30d: number;
  loads_this_week: number;
  loads_last_week: number;
  tickets_this_week: number;
  tickets_last_week: number;
  alerts_critical: number;
  alerts_action: number;
  last_activity_at: string | null;
  support_visits_30d: number;
  last_support_visit_at: string | null;
  week_start: string;
}

export type HealthTone = "green" | "amber" | "gray" | "critical-soft" | "blue";
export interface HealthVerdict { label: string; tone: HealthTone; detail: string }

const DAY = 86_400_000;
function daysSince(at: string | null, now: number): number | null {
  if (!at) return null;
  return Math.max(0, Math.floor((now - new Date(at).getTime()) / DAY));
}

/**
 * A plain verdict for a company: "Active this week", "Quiet for 12 days", "Not signed in yet", "Inactive". Activity
 * is the later of a company person's last sign-in and their last recorded change (Taviron staff never count).
 */
export function healthVerdict(h: Pick<CompanyHealth, "active" | "members" | "last_sign_in_at" | "last_activity_at" | "is_demo">, now: number): HealthVerdict {
  if (!h.active) return { label: "Inactive", tone: "gray", detail: "Its people cannot open it." };
  if (h.members === 0) return { label: "No one can sign in yet", tone: "amber", detail: "Nobody has a sign-in for this company yet." };
  const times = [h.last_sign_in_at, h.last_activity_at].filter((t): t is string => Boolean(t)).map((t) => new Date(t).getTime());
  if (times.length === 0) return { label: "Not signed in yet", tone: "amber", detail: `${h.members} ${h.members === 1 ? "person has" : "people have"} a sign-in; nobody has used it yet.` };
  const last = new Date(Math.max(...times)).toISOString();
  const days = daysSince(last, now) ?? 0;
  if (days <= 7) return { label: days === 0 ? "Active today" : "Active this week", tone: "green", detail: days === 0 ? "Someone used it today." : `Last used ${days} day${days === 1 ? "" : "s"} ago.` };
  return { label: `Quiet for ${days} days`, tone: days > 30 ? "critical-soft" : "amber", detail: `Nobody has signed in or changed anything for ${days} days.` };
}

/** "3 this week · 5 last week" style comparison; the trend word only when both weeks have a number to compare. */
export function weekCompare(thisWeek: number, lastWeek: number): string {
  if (thisWeek === 0 && lastWeek === 0) return "None this week or last week";
  const trend = thisWeek > lastWeek ? "up" : thisWeek < lastWeek ? "down" : "same as";
  return `${thisWeek} this week · ${trend === "same as" ? "same as" : `${trend} from`} ${lastWeek} last week`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Usage trends (platform_company_usage)

export interface UsageWeek { week_start: string; loads: number; tickets: number; active_people: number; ai_requests: number }

// ---------------------------------------------------------------------------------------------------------------------
// Customer timeline (platform_company_timeline)

export interface TimelineItem {
  at: string;
  source: "lead" | "platform" | "onboarding" | "support" | "subscription";
  kind: string;
  summary: string;
  detail: Record<string, unknown> | null;
  note: string;
  actor: string;
}

export const TIMELINE_SOURCES: Record<TimelineItem["source"], string> = {
  lead: "Lead",
  platform: "Taviron",
  onboarding: "Onboarding",
  support: "Support visit",
  subscription: "Subscription",
};

const ONBOARDING_KIND: Record<string, string> = {
  created: "Task added",
  status: "Task status changed",
  comment: "Comment",
  document: "Document added",
  assigned: "Task assigned",
  reminder: "Reminder sent in the app",
  import: "Records imported",
};
const TASK_STATUS: Record<string, string> = {
  not_started: "Not started", in_progress: "In progress", awaiting_customer: "Waiting for the customer", submitted: "Submitted for review",
  changes_requested: "Changes requested", approved: "Approved", blocked: "Blocked", not_applicable: "Not applicable",
};
const SUBSCRIPTION_KIND: Record<string, string> = {
  renewal_reminder: "Renewal reminder",
  over_limit: "Over the plan's limits",
  grace_ending: "Grace period ending",
  back_within_limits: "Back within the plan's limits",
  tier_change_due: "Plan change proposed",
  tier_change_scheduled: "Plan change scheduled",
  tier_change_applied: "Plan change applied",
  tier_change_canceled: "Plan change canceled",
};
const VISIT_END: Record<string, string> = { left: "left", switched: "went to another company", access_ended: "the owner ended access", staff_removed: "removed from the team", "": "the visit time ran out" };

/** The title and the line under it for one timeline entry. */
export function timelineText(i: TimelineItem): { title: string; detail: string } {
  const d = i.detail ?? {};
  switch (i.source) {
    case "lead": {
      const change = leadEventDetail({ action: i.kind, detail: d }, new Map());
      return { title: leadEventText(i.kind), detail: [i.summary ? `Lead ${i.summary}` : "", change, i.note].filter(Boolean).join(" · ") };
    }
    case "platform":
      return { title: activityText({ source: "platform", action: i.kind }), detail: i.summary };
    case "onboarding": {
      const from = typeof d.from === "string" && d.from ? TASK_STATUS[d.from] ?? d.from : "";
      const to = typeof d.to === "string" && d.to ? TASK_STATUS[d.to] ?? d.to : "";
      const change = i.kind === "status" && to ? `${from || "Not started"} → ${to}` : "";
      const internal = d.internal === true ? "Taviron only" : "";
      return { title: ONBOARDING_KIND[i.kind] ?? activityText(i.kind), detail: [i.summary, change, internal, i.note].filter(Boolean).join(" · ") };
    }
    case "support":
      if (i.kind === "visit_started") return { title: "Taviron support went in", detail: i.summary ? `Helping with: ${i.summary}` : "No reason given" };
      return { title: "Support visit ended", detail: `Ended: ${VISIT_END[i.summary] ?? i.summary}` };
    case "subscription":
      return { title: SUBSCRIPTION_KIND[i.kind] ?? activityText(i.kind), detail: [i.summary, i.note].filter(Boolean).join(" · ") };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Support inbox (platform_support_inbox, platform_support_request, platform_my_support_work)

export const REQUEST_STATUSES = ["new", "answered", "closed"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_STATUS_LABELS: Record<RequestStatus, string> = { new: "New", answered: "Answered", closed: "Closed" };
export const REQUEST_STATUS_TONES: Record<RequestStatus, "amber" | "blue" | "gray"> = { new: "amber", answered: "blue", closed: "gray" };
export function isRequestStatus(v: unknown): v is RequestStatus {
  return typeof v === "string" && (REQUEST_STATUSES as readonly string[]).includes(v);
}
export const INBOX_FILTERS = [
  { key: "open", label: "Open" },
  { key: "new", label: "New" },
  { key: "answered", label: "Answered" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All" },
] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number]["key"];

export interface InboxItem {
  id: string; company_id: string; company: string; is_demo: boolean; stage: string; from_name: string; from_email: string;
  page: string; article_id: string | null; message: string; status: RequestStatus; created_at: string; updated_at: string | null;
  notes: number; last_note_at: string | null; handled_by: string | null;
}
export interface Inbox { counts: { new: number; answered: number; closed: number; all: number }; items: InboxItem[] }
export interface SupportNote { kind: "note" | "reply"; body: string; at: string; author: string }
export interface SupportRequestDetail extends Omit<InboxItem, "notes" | "last_note_at"> { from_role: string | null; notes: SupportNote[] }

/** A reply opened in the staff member's own email program (Taviron sends nothing itself). */
export function replyMailto(to: string, company: string, body: string): string {
  const subject = `Your Taviron support request (${company})`;
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export interface MyVisit { id: string; company_id: string; company: string; is_demo: boolean; reason: string; started_at: string; ends_at: string; ended_at: string | null; end_reason: string; open: boolean }
export interface MyChangeRequest { id: string; company_id: string; company: string; summary: string; note: string; status: string; created_at: string; expires_at: string; decided_at: string | null; decided_by: string | null; result: string }
export interface MySupportWork { visits: MyVisit[]; requests: MyChangeRequest[] }

export const CHANGE_REQUEST_LABELS: Record<string, { label: string; tone: "amber" | "green" | "gray" | "critical-soft" | "blue" }> = {
  pending: { label: "Waiting for the owner", tone: "amber" },
  running: { label: "Being applied", tone: "blue" },
  done: { label: "Approved and done", tone: "green" },
  failed: { label: "Did not finish", tone: "critical-soft" },
  declined: { label: "Declined by the owner", tone: "gray" },
  withdrawn: { label: "Withdrawn", tone: "gray" },
  expired: { label: "Expired", tone: "gray" },
};
export function visitEndText(v: Pick<MyVisit, "open" | "end_reason">): string {
  if (v.open) return "In progress";
  if (v.end_reason === "expired") return "Time ran out";
  return VISIT_END[v.end_reason] ? `Ended: ${VISIT_END[v.end_reason]}` : "Ended";
}

// ---------------------------------------------------------------------------------------------------------------------
// Console search (platform_search)

export interface ConsoleSearch {
  companies: Array<{ id: string; name: string; is_demo: boolean; active: boolean; stage: string }>;
  requests: Array<{ id: string; company: string; status: RequestStatus; message: string; created_at: string }>;
  leads: Array<{ id: string; name: string; company_name: string; status: LeadStatus; disposition: string; created_at: string }>;
  prospects: Array<{ id: string; company_name: string; city: string; state: string; status: string }>;
  team: Array<{ user_id: string; name: string; email: string; level: "admin" | "support" }>;
}
export interface SearchHit { group: string; href: string; title: string; detail: string }

/** Every result as a link, grouped in a fixed order. Support staff go to the company desk; Admins to the record. */
export function searchHits(r: ConsoleSearch, level: "admin" | "support"): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const c of r.companies) {
    hits.push({
      group: "Companies",
      href: level === "admin" && !c.is_demo ? `/admin/companies/${c.id}` : `/staff?q=${encodeURIComponent(c.name)}`,
      title: c.name,
      detail: [stageLabel(c.stage), c.active ? "" : "inactive"].filter(Boolean).join(" · "),
    });
  }
  for (const q of r.requests) hits.push({ group: "Support requests", href: `${level === "admin" ? "/admin/support" : "/staff/support"}/${q.id}`, title: `${q.company}: ${q.message}`, detail: `${REQUEST_STATUS_LABELS[q.status] ?? q.status} · ${formatDate(q.created_at.slice(0, 10))}` });
  for (const l of r.leads) hits.push({ group: "Leads", href: `/admin/leads/${l.id}`, title: l.name, detail: [l.company_name, l.disposition === "spam" ? "Spam" : LEAD_STATUS_LABELS[l.status] ?? l.status].filter(Boolean).join(" · ") });
  for (const p of r.prospects) hits.push({ group: "Outreach", href: `/admin/outreach/${p.id}`, title: p.company_name, detail: [p.city, p.state].filter(Boolean).join(", ") });
  for (const t of r.team) hits.push({ group: "Taviron team", href: "/admin/platform", title: t.name || t.email, detail: `${t.level === "admin" ? "Admin" : "Support"} · ${t.email}` });
  return hits;
}

// ---------------------------------------------------------------------------------------------------------------------
// Audit log (platform_audit_search, platform_audit_facets)

export interface AuditRow { id: number; occurred_at: string; actor_id: string | null; actor: string; action: string; target_type: string; target_id: string; summary: string; company_id: string | null; company: string | null }
export interface AuditFacets { actions: Array<{ action: string; n: number }>; actors: Array<{ id: string; name: string }> }
export interface AuditFilters { actor: string; action: string; company: string; from: string; to: string; before: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Filters from the address bar; anything malformed is dropped (never sent to the database as typed). */
export function parseAuditFilters(sp: Record<string, string | string[] | undefined>): AuditFilters {
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string).trim() : "");
  const actor = one("actor"), company = one("company"), action = one("action"), from = one("from"), to = one("to"), before = one("before");
  return {
    actor: UUID.test(actor) ? actor : "",
    company: UUID.test(company) ? company : "",
    action: /^[a-z][a-z0-9_.]{1,60}$/.test(action) ? action : "",
    from: DAY_RE.test(from) ? from : "",
    to: DAY_RE.test(to) ? to : "",
    before: /^\d{1,18}$/.test(before) ? before : "",
  };
}

/** The address of the same filters, optionally on another page (before = the last id shown). */
export function auditHref(f: AuditFilters, before?: string): string {
  const q = new URLSearchParams();
  for (const k of ["actor", "action", "company", "from", "to"] as const) if (f[k]) q.set(k, f[k]);
  if (before) q.set("before", before);
  const s = q.toString();
  return `/admin/platform${s ? `?${s}` : ""}#audit`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Lead pipeline (platform_lead_pipeline)

export interface PipelineLead {
  id: string; kind: "demo" | "contact"; status: LeadStatus; name: string; company_name: string; truck_count: number | null; owner_name: string | null;
  follow_up_on: string | null; demo_on: string | null; onboarding_stage: string; created_at: string; updated_at: string;
}

/** The leads of one status column, the most pressing first: demo dates soonest, then follow-ups due, then newest. */
export function pipelineColumn(leads: PipelineLead[], status: LeadStatus): PipelineLead[] {
  const key = (l: PipelineLead) => [l.demo_on ?? "9999-12-31", l.follow_up_on ?? "9999-12-31", String(9e15 - new Date(l.created_at).getTime()).padStart(20, "0")].join("|");
  return leads.filter((l) => l.status === status).sort((a, b) => key(a).localeCompare(key(b)));
}

/** What the card says about dates: the demo day and the follow-up, with "overdue" when it is past (today in the console's time). */
export function pipelineDates(l: Pick<PipelineLead, "demo_on" | "follow_up_on" | "status">, today: string): Array<{ text: string; tone: "blue" | "critical-soft" | "amber" | "gray" }> {
  const out: Array<{ text: string; tone: "blue" | "critical-soft" | "amber" | "gray" }> = [];
  if (l.demo_on) out.push({ text: `${l.demo_on < today ? "Demo was" : l.demo_on === today ? "Demo today," : "Demo"} ${formatDate(l.demo_on)}`, tone: l.demo_on === today ? "amber" : l.demo_on < today ? "gray" : "blue" });
  const closed = l.status === "converted" || l.status === "not_proceeding";
  if (l.follow_up_on && !closed) {
    const overdue = l.follow_up_on < today;
    out.push({ text: `${overdue ? "Follow-up overdue since" : l.follow_up_on === today ? "Follow up today," : "Follow up"} ${formatDate(l.follow_up_on)}`, tone: overdue ? "critical-soft" : l.follow_up_on === today ? "amber" : "gray" });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Security overview (platform_security_overview)

export interface SecurityOverview {
  as_of: string;
  signin_failures: { day: number; week: number; logins_week: number };
  mfa: { failed_day: number; failed_week: number; ok_week: number; people_failed_week: number };
  access: Array<{ scope: string; failed_day: number; failed_week: number; ok_week: number }>;
  events: Array<{ event: string; n: number }>;
  recent: Array<{ event: string; at: string; person: string; staff: boolean }>;
}

const SECURITY_EVENTS: Record<string, string> = {
  "mfa.enrolled": "Set up an authenticator app",
  "mfa.verified": "Entered an authenticator code",
  "mfa.removed": "Removed an authenticator app",
  "mfa.challenge_failed": "Wrong authenticator code",
  "mfa.reset": "Lost authenticator removed",
  "mfa.company_policy": "Company two-step rule changed",
  "mfa.recovery_generated": "Created recovery codes",
  "mfa.recovery_confirmed": "Confirmed recovery codes were saved",
  "mfa.recovery_used": "Signed in with a recovery code",
  "mfa.recovery_failed": "Wrong recovery code",
  "account.setup_issued": "Sign-in setup link created",
  "account.setup_completed": "Sign-in set up from a link",
  "account.qr_issued": "Sign-in QR code created",
};
export function securityEventText(event: string): string {
  return SECURITY_EVENTS[event] ?? activityText(event);
}
const ACCESS_SCOPES: Record<string, string> = { ip: "Access code tries from one network", email: "Access code tries for one email", user: "Access code tries by a signed-in person", site: "Website access code tries" };
export function accessScopeText(scope: string): string {
  return ACCESS_SCOPES[scope] ?? `Access code tries (${scope})`;
}
