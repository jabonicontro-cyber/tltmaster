export const LEAD_STATUSES = ["new", "contacted", "demo_scheduled", "qualified", "onboarding", "won", "lost", "spam"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  demo_scheduled: "Demo scheduled",
  qualified: "Qualified",
  onboarding: "Onboarding",
  won: "Won",
  lost: "Lost",
  spam: "Spam",
};

export const LEAD_STATUS_TONES: Record<LeadStatus, "gray" | "blue" | "green" | "amber" | "red" | "dark" | "brand"> = {
  new: "brand",
  contacted: "blue",
  demo_scheduled: "blue",
  qualified: "amber",
  onboarding: "amber",
  won: "green",
  lost: "gray",
  spam: "gray",
};

export function isLeadStatus(v: unknown): v is LeadStatus {
  return typeof v === "string" && (LEAD_STATUSES as readonly string[]).includes(v);
}

const EVENT_TEXT: Record<string, string> = {
  submitted: "Submitted the form",
  resubmitted: "Sent the form again",
  status_changed: "Changed the status",
  owner_changed: "Changed the owner",
  follow_up_changed: "Changed the follow-up date",
  note_added: "Added a note",
  company_created: "Created the company for onboarding",
};
export function leadEventText(action: string): string {
  return EVENT_TEXT[action] ?? action;
}
