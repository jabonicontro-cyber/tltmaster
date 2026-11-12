// Platform owner Launchpad (20261118000100): the shape of public.platform_launchpad() and how each item is explained
// and linked. The database decides what needs attention; this file only names it and points to the record.

export interface LaunchpadAttentionItem {
  kind: AttentionKind;
  priority: number;
  title: string;
  detail: string;
  ref_type: "lead" | "import" | "company" | "demo";
  ref_id: string;
  since: string | null;
  due_on: string | null;
}

export interface LaunchpadDemo {
  id: string;
  name: string;
  kind: "presenter" | "prospect" | null;
  created_at: string;
  last_refresh_at: string | null;
  last_refresh_ok: boolean | null;
  last_refresh_summary: string | null;
}

export interface LaunchpadActivity {
  at: string;
  source: "platform" | "lead";
  action: string;
  summary: string;
  actor: string;
  ref_type: string;
  ref_id: string;
}

export interface Launchpad {
  as_of: string;
  companies: { total: number; active: number; inactive: number; created_30d: number; setup_incomplete: number };
  leads: {
    by_status: Record<string, number>; new: number; overdue: number; due_today: number; demo_scheduled: number; onboarding: number;
    /** 20261120020200: open leads with a demo booked from today, and the next demo day (absent before that update). */
    demo_dated?: number; next_demo_on?: string | null;
  };
  imports: { in_review: number; oldest_review_at: string | null; approved_30d: number };
  email_failures_7d: number;
  demos: LaunchpadDemo[];
  attention: { items: LaunchpadAttentionItem[]; total: number; by_kind: Partial<Record<AttentionKind, number>> };
  activity: LaunchpadActivity[];
}

export const ATTENTION_KINDS = ["lead_overdue", "lead_email_failed", "demo_refresh_failed", "lead_due_today", "lead_new", "import_review", "company_setup"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_LABELS: Record<AttentionKind, string> = {
  lead_overdue: "Follow-up overdue",
  lead_email_failed: "Email failed",
  demo_refresh_failed: "Demo refresh failed",
  lead_due_today: "Follow-up today",
  lead_new: "New lead",
  import_review: "Import to review",
  company_setup: "Setup Not Complete",
};

/** What to do about each kind (the button text on the item). */
export const ATTENTION_ACTIONS: Record<AttentionKind, string> = {
  lead_overdue: "Open the lead",
  lead_email_failed: "Check the email log",
  demo_refresh_failed: "Open Live demo",
  lead_due_today: "Open the lead",
  lead_new: "Contact them",
  import_review: "Review the import",
  company_setup: "Open the company",
};

export function attentionHref(i: Pick<LaunchpadAttentionItem, "ref_type" | "ref_id">): string {
  switch (i.ref_type) {
    case "lead": return `/admin/leads/${i.ref_id}`;
    case "import": return `/admin/onboarding/batch/${i.ref_id}`;
    case "company": return `/admin/companies/${i.ref_id}`;
    case "demo": return "/admin/demo";
  }
}

/**
 * Every action the database writes to the platform audit log (private.platform_log and the operator's direct inserts)
 * and to a lead's history (private.lead_events), in plain words. One map for the whole console: the Launchpad, the
 * audit log, the company page and its timeline. tests/unit/console-labels.test.ts fails when a migration writes an
 * action that has no label here.
 */
export const ACTIVITY_TEXT: Record<string, string> = {
  // Taviron team and access
  admin_granted: "Platform access granted",
  admin_revoked: "Platform access removed",
  staff_invited: "Team invitation sent",
  staff_invite_revoked: "Team invitation withdrawn",
  staff_joined: "Joined the Taviron team",
  staff_level_changed: "Team level changed",
  staff_removed: "Removed from the Taviron team",
  // Support
  support_entered: "Went into a company as support",
  support_left: "Left a company",
  support_request: "Asked an owner to approve a change",
  support_request_status: "Support request status changed",
  support_request_note: "Note added to a support request",
  support_request_reply: "Reply written to a support request",
  // Demos and the Testing Lab
  demo_started: "Demo started",
  demo_entered: "Demo opened",
  demo_refreshed: "Demo data refreshed",
  demo_refresh_failed: "Demo refresh failed",
  demo_plan_set: "Demo plan changed",
  prospect_demo_created: "Prospect demo created",
  prospect_demo_retired: "Prospect demo retired",
  "testing_lab.check": "Testing Lab result recorded",
  "testing_lab.portal_preview": "Customer portal preview opened",
  // Companies
  company_created: "Company created",
  company_classified: "Company classification changed",
  company_archived: "Company archived",
  company_restored: "Company restored",
  company_deleted: "Company permanently deleted",
  "portal.entitlement": "Customer portal entitlement changed",
  "hired_trucks.entitlement": "Hired trucks switched on or off",
  // Imports and onboarding
  import_staged: "Import uploaded for review",
  import_approved: "Import approved",
  import_discarded: "Import discarded",
  import_reverted: "Import reverted",
  "onboarding.generate": "Onboarding checklist updated",
  "onboarding.status": "Onboarding task status changed",
  go_live_signed: "Go-live signed off",
  go_live_signoff_voided: "Go-live sign-off withdrawn",
  // Subscriptions and plans
  lifecycle_terms_set: "Subscription terms set",
  onboarding_fee_paid: "Onboarding fee recorded as received",
  onboarding_fee_waived: "Onboarding fee waived",
  go_live_scheduled: "Go-live date set",
  company_went_live: "Company went live",
  subscription_canceled: "Subscription canceled",
  plan_version_created: "New plan price version",
  attention_acknowledged: "Attention item acknowledged",
  // A lead's history
  submitted: "Lead sent the website form",
  resubmitted: "Lead sent the form again",
  status_changed: "Lead status changed",
  owner_changed: "Lead owner changed",
  follow_up_changed: "Lead follow-up date changed",
  demo_date_changed: "Lead demo date changed",
  note_added: "Note added to a lead",
  disposition_changed: "Lead spam flag changed",
  onboarding_changed: "Lead onboarding progress changed",
  status_consolidated: "Lead statuses consolidated",
};

/** Lead-history actions that read differently in a mixed activity feed. */
const LEAD_ACTIVITY_TEXT: Record<string, string> = { company_created: "Company created from a lead" };

/** A readable label for any action; one without a label still reads as words ("some.new_thing" → "Some new thing"). */
export function activityText(a: Pick<LaunchpadActivity, "source" | "action"> | string): string {
  const action = typeof a === "string" ? a : a.action;
  if (typeof a !== "string" && a.source === "lead" && LEAD_ACTIVITY_TEXT[action]) return LEAD_ACTIVITY_TEXT[action];
  const known = ACTIVITY_TEXT[action];
  if (known) return known;
  const words = action.replace(/[._]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Something changed";
}

/** Acknowledged attention items record their kind as the target type; they point at the record behind the item. */
const ATTENTION_REF: Record<string, string> = {
  lead_overdue: "lead", lead_due_today: "lead", lead_new: "lead", lead_email_failed: "lead", import_review: "import", company_setup: "company", demo_refresh_failed: "company",
};

export function activityHref(a: Pick<LaunchpadActivity, "ref_type" | "ref_id">): string | null {
  if (!a.ref_id) return null;
  const ref = ATTENTION_REF[a.ref_type] ?? a.ref_type;
  if (ref === "lead") return `/admin/leads/${a.ref_id}`;
  if (ref === "company") return `/admin/companies/${a.ref_id}`;
  if (ref === "import") return `/admin/onboarding/batch/${a.ref_id}`;
  if (ref === "support_request") return `/admin/support/${a.ref_id}`;
  if (ref === "testing_lab") return "/admin/testing-lab";
  if (ref === "user") return "/admin/platform";
  return null;
}

/** The line under "Demos scheduled": how many have a demo date booked and the next one (20261120020200). */
export function demoScheduledSub(leads: Launchpad["leads"], formatDay: (d: string) => string): string {
  if (leads.demo_dated === undefined) return "Leads in Demo Scheduled";
  if (!leads.demo_dated) return "No demo date booked yet: add one on the lead";
  return `${leads.demo_dated} with a demo date${leads.next_demo_on ? ` · next ${formatDay(leads.next_demo_on)}` : ""}`;
}

/** The line under "Customer companies": live, active in all, and those without a subscription record yet. */
export function customersSub(c: { live: number; total: number; not_set_up?: number }): string {
  return `live · ${c.total} active in all${c.not_set_up ? ` · ${c.not_set_up} subscription not set up` : ""}`;
}

/** "3 days" / "5 hours" / "just now" since an instant. */
export function ageText(since: string | null, now: number): string {
  if (!since) return "";
  const ms = now - new Date(since).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "less than an hour";
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}
