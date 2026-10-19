// Guided onboarding checklist (master plan §12 B68; docs/ONBOARDING.md §4; migration 20261120001000). Pure: labels,
// tones and which status changes each side may offer. The database enforces the same rules (private.onboarding_change);
// this module only decides which buttons to show, so a button never appears for a change the database would refuse.

export const ONBOARDING_STATUSES = [
  "not_started", "in_progress", "awaiting_customer", "submitted", "changes_requested", "approved", "blocked", "not_applicable",
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export type OnboardingSide = "customer" | "taviron" | "shared";

export interface OnboardingEvent {
  id: string;
  kind: "created" | "status" | "comment" | "document" | "assigned" | "reminder" | "import";
  actor_side: "customer" | "taviron" | "system";
  actor_name: string | null;
  from_status: OnboardingStatus | null;
  to_status: OnboardingStatus | null;
  body: string;
  internal: boolean;
  created_at: string;
}

export interface OnboardingDocument {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  side: "customer" | "taviron";
  uploaded_at: string;
}

export interface OnboardingTask {
  id: string;
  key: string;
  title: string;
  instructions: string;
  category: string;
  side: OnboardingSide;
  review_required: boolean;
  required: boolean;
  readiness_id: string | null;
  import_entity: "customers" | "materials" | "trucks" | "drivers" | null;
  depends_on: string[];
  /** Titles of dependencies not yet approved or not applicable. */
  unmet: string[];
  status: OnboardingStatus;
  status_note: string;
  assignee: string | null;
  assignee_name: string | null;
  due_on: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  last_reminded_at: string | null;
  updated_at: string;
  documents: OnboardingDocument[];
  events: OnboardingEvent[];
}

export interface OnboardingSummary {
  total: number;
  required: number;
  required_done: number;
  done: number;
  customer_actions: number;
  review: number;
  blocked: number;
  overdue: number;
  ready: boolean;
}

export interface OnboardingState {
  company_id: string;
  tasks: OnboardingTask[];
  summary: OnboardingSummary;
}

export type Tone = "gray" | "blue" | "amber" | "green" | "red";

/** Label for a status; an approved task that needed no review reads "Completed". */
export function statusLabel(status: OnboardingStatus, reviewRequired = true): string {
  switch (status) {
    case "not_started": return "Not started";
    case "in_progress": return "In progress";
    case "awaiting_customer": return "Awaiting customer";
    case "submitted": return "Submitted for review";
    case "changes_requested": return "Changes requested";
    case "approved": return reviewRequired ? "Approved" : "Completed";
    case "blocked": return "Blocked";
    case "not_applicable": return "Not applicable";
  }
}

export const STATUS_TONE: Record<OnboardingStatus, Tone> = {
  not_started: "gray",
  in_progress: "blue",
  awaiting_customer: "amber",
  submitted: "blue",
  changes_requested: "amber",
  approved: "green",
  blocked: "red",
  not_applicable: "gray",
};

export const SIDE_LABEL: Record<OnboardingSide, string> = { customer: "Your team", taviron: "Taviron", shared: "Together" };
export const SIDE_LABEL_STAFF: Record<OnboardingSide, string> = { customer: "Customer", taviron: "Taviron", shared: "Shared" };

export const isFinished = (s: OnboardingStatus) => s === "approved" || s === "not_applicable";

export interface StatusAction {
  status: OnboardingStatus;
  label: string;
  /** The database refuses this change without a reason. */
  needsNote: boolean;
  primary?: boolean;
}

/** Status changes the company side may make on this task (mirrors private.onboarding_change). */
export function customerActions(t: Pick<OnboardingTask, "side" | "status" | "review_required" | "unmet">): StatusAction[] {
  if (t.side === "taviron" || isFinished(t.status)) return [];
  if (t.status === "submitted") return [{ status: "in_progress", label: "Withdraw submission", needsNote: false }];
  const out: StatusAction[] = [];
  const depsMet = t.unmet.length === 0;
  if (t.review_required) {
    if (depsMet) out.push({ status: "submitted", label: t.status === "changes_requested" ? "Resubmit for review" : "Submit for review", needsNote: false, primary: true });
  } else if (depsMet) {
    out.push({ status: "approved", label: "Mark complete", needsNote: false, primary: true });
  }
  if (t.status !== "in_progress") out.push({ status: "in_progress", label: "Start", needsNote: false });
  if (t.status !== "blocked") out.push({ status: "blocked", label: "Mark blocked", needsNote: true });
  return out;
}

/** Status changes Taviron may make (any change, with the same reason and dependency rules). */
export function staffActions(t: Pick<OnboardingTask, "status" | "required" | "unmet" | "review_required">): StatusAction[] {
  const out: StatusAction[] = [];
  const depsMet = t.unmet.length === 0;
  if (t.status !== "approved" && depsMet) out.push({ status: "approved", label: t.review_required ? "Approve" : "Mark complete", needsNote: false, primary: true });
  if (t.status === "submitted") out.push({ status: "changes_requested", label: "Request changes", needsNote: true });
  if (!isFinished(t.status) && t.status !== "awaiting_customer") out.push({ status: "awaiting_customer", label: "Awaiting customer", needsNote: false });
  if (!isFinished(t.status) && t.status !== "in_progress") out.push({ status: "in_progress", label: "In progress", needsNote: false });
  if (t.status !== "blocked" && !isFinished(t.status)) out.push({ status: "blocked", label: "Blocked", needsNote: true });
  if (t.status !== "not_applicable") out.push({ status: "not_applicable", label: "Not applicable", needsNote: t.required });
  if (isFinished(t.status)) out.push({ status: "in_progress", label: "Reopen", needsNote: false });
  return out;
}

/** Does the company side need to do something on this task now? */
export function needsCustomer(t: Pick<OnboardingTask, "side" | "status">): boolean {
  return t.side !== "taviron" && ["not_started", "in_progress", "awaiting_customer", "changes_requested", "blocked"].includes(t.status);
}

/** Order for the company's view: what needs them first, then waiting on Taviron, then finished. */
export function customerOrder(tasks: OnboardingTask[]): OnboardingTask[] {
  const rank = (t: OnboardingTask) => (t.status === "changes_requested" || t.status === "awaiting_customer" ? 0 : needsCustomer(t) ? 1 : isFinished(t.status) ? 3 : 2);
  return [...tasks].sort((a, b) => rank(a) - rank(b));
}

/** Overdue: a due date before today on a task that is not finished. */
export function isOverdue(t: Pick<OnboardingTask, "due_on" | "status">, today: string): boolean {
  return Boolean(t.due_on && t.due_on < today && !isFinished(t.status));
}

// -----------------------------------------------------------------------------
// Documents
// -----------------------------------------------------------------------------

export const MAX_ONBOARDING_FILE_BYTES = 10 * 1024 * 1024;
export type OnboardingFileType = "application/pdf" | "image/jpeg" | "image/png" | "text/csv";

/** The real type of an uploaded file from its first bytes (and, for CSV, readable text and the .csv name). */
export function detectOnboardingFile(bytes: Uint8Array, fileName: string): OnboardingFileType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (/\.csv$/i.test(fileName.trim())) {
    if (bytes.includes(0)) return null;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return "text/csv";
    } catch {
      return null;
    }
  }
  return null;
}

export type FileCheck = { ok: true; type: OnboardingFileType } | { ok: false; status: number; error: string };

export function checkOnboardingFile(bytes: Uint8Array, fileName: string): FileCheck {
  if (bytes.length === 0) return { ok: false, status: 400, error: "The file is empty." };
  if (bytes.length > MAX_ONBOARDING_FILE_BYTES) return { ok: false, status: 413, error: "A file must be 10 MB or smaller." };
  const type = detectOnboardingFile(bytes, fileName);
  if (!type) return { ok: false, status: 415, error: "Only PDF, JPEG, PNG or CSV (UTF-8 text) files can be added." };
  return { ok: true, type };
}
