import { formatDate } from "@/lib/dates";

// The six lead statuses (founder's decision, 2026-10-11). Earlier statuses were
// folded into these by migration 20261028000100; spam is an internal flag on a
// Not Proceeding lead, and onboarding progress is tracked separately.
export const LEAD_STATUSES = ["new", "contacted", "demo_scheduled", "demo_completed", "converted", "not_proceeding"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  demo_scheduled: "Demo Scheduled",
  demo_completed: "Demo Completed",
  converted: "Converted",
  not_proceeding: "Not Proceeding",
};

export const LEAD_STATUS_TONES: Record<LeadStatus, "gray" | "blue" | "green" | "amber" | "red" | "dark" | "brand"> = {
  new: "brand",
  contacted: "blue",
  demo_scheduled: "blue",
  demo_completed: "amber",
  converted: "green",
  not_proceeding: "gray",
};

/** Statuses from before the consolidation, shown only in the history of older leads. */
export const LEGACY_STATUS_LABELS: Record<string, string> = { qualified: "Qualified", onboarding: "Onboarding", won: "Won", lost: "Lost", spam: "Spam" };

export function statusLabel(s: unknown): string {
  return typeof s === "string" ? LEAD_STATUS_LABELS[s as LeadStatus] ?? LEGACY_STATUS_LABELS[s] ?? s : "";
}

export function isLeadStatus(v: unknown): v is LeadStatus {
  return typeof v === "string" && (LEAD_STATUSES as readonly string[]).includes(v);
}

/** Onboarding progress of a Converted lead. */
export const ONBOARDING_STAGES = ["", "in_progress", "live"] as const;
export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];
export const ONBOARDING_LABELS: Record<OnboardingStage, string> = { "": "Not started", in_progress: "In progress", live: "Live" };
export function isOnboardingStage(v: unknown): v is OnboardingStage {
  return typeof v === "string" && (ONBOARDING_STAGES as readonly string[]).includes(v);
}

export const EMAIL_KIND_LABELS: Record<string, string> = { confirmation: "Confirmation to the prospect", notification: "Notification to Taviron" };
export const EMAIL_STATUS_LABELS: Record<string, string> = { sent: "Sent", failed: "Failed", not_sent: "Not sent" };

const EVENT_TEXT: Record<string, string> = {
  submitted: "Submitted the form",
  resubmitted: "Sent the form again",
  status_changed: "Changed the status",
  owner_changed: "Changed the owner",
  follow_up_changed: "Changed the follow-up date",
  demo_date_changed: "Changed the demo date",
  note_added: "Added a note",
  company_created: "Created the company for onboarding",
  status_consolidated: "Status list consolidated",
  disposition_changed: "Changed the spam flag",
  onboarding_changed: "Changed onboarding progress",
};
export function leadEventText(action: string): string {
  return EVENT_TEXT[action] ?? action.replace(/[._]+/g, " ");
}

/** A recorded day ("2026-11-14") as people read it ("Nov 14, 2026"); nothing recorded reads as "none". */
export function dayOrNone(v: unknown): string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v) : "none";
}

/** What a history entry changed, in words: "New → Contacted", "none → Nov 14, 2026", "Pia → nobody". */
export function leadEventDetail(e: { action: string; detail: Record<string, unknown> | null }, team: Map<string, string>): string {
  const d = e.detail ?? {};
  const name = (v: unknown) => (typeof v === "string" ? team.get(v) ?? "someone no longer on the team" : "nobody");
  switch (e.action) {
    case "status_changed":
    case "status_consolidated":
      return `${statusLabel(d.from)} → ${statusLabel(d.to)}${d.disposition === "spam" ? " (flagged as spam)" : ""}`;
    case "disposition_changed":
      return d.to === "spam" ? "Flagged as spam" : "Spam flag removed";
    case "onboarding_changed":
      return `${ONBOARDING_LABELS[d.from as OnboardingStage] ?? String(d.from ?? "")} → ${ONBOARDING_LABELS[d.to as OnboardingStage] ?? String(d.to ?? "")}`;
    case "owner_changed":
      return `${name(d.from)} → ${name(d.to)}`;
    case "follow_up_changed":
    case "demo_date_changed":
      return `${dayOrNone(d.from)} → ${dayOrNone(d.to)}`;
    case "submitted":
    case "resubmitted":
      return d.kind === "demo" ? "Demo request" : "Contact form";
    case "company_created":
      return String(d.company_name ?? "");
    default:
      return "";
  }
}
