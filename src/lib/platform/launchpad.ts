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
  leads: { by_status: Record<string, number>; new: number; overdue: number; due_today: number; demo_scheduled: number; onboarding: number };
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
  company_setup: "Setup incomplete",
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

const ACTIVITY_TEXT: Record<string, string> = {
  admin_granted: "Platform access granted",
  admin_revoked: "Platform access revoked",
  demo_started: "Demo started",
  demo_entered: "Demo opened",
  demo_refreshed: "Demo refreshed",
  demo_refresh_failed: "Demo refresh failed",
  company_created: "Company created",
  import_staged: "Import uploaded for review",
  import_approved: "Import approved",
  import_discarded: "Import discarded",
  import_reverted: "Import reverted",
  prospect_demo_created: "Prospect demo created",
  prospect_demo_retired: "Prospect demo retired",
  submitted: "Lead submitted the form",
  resubmitted: "Lead sent the form again",
  status_changed: "Lead status changed",
  owner_changed: "Lead owner changed",
  follow_up_changed: "Lead follow-up date changed",
  note_added: "Note added to a lead",
  disposition_changed: "Lead spam flag changed",
  onboarding_changed: "Lead onboarding progress changed",
};

export function activityText(a: Pick<LaunchpadActivity, "source" | "action">): string {
  return ACTIVITY_TEXT[a.action] ?? a.action.replaceAll("_", " ");
}

export function activityHref(a: Pick<LaunchpadActivity, "ref_type" | "ref_id">): string | null {
  if (!a.ref_id) return null;
  if (a.ref_type === "lead") return `/admin/leads/${a.ref_id}`;
  if (a.ref_type === "company") return `/admin/companies/${a.ref_id}`;
  if (a.ref_type === "import") return `/admin/onboarding/batch/${a.ref_id}`;
  return null;
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
