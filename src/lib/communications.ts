// Communications: labels, rules shared by pages, actions and tests. Every rule
// that protects data (membership, history, permissions, safety minimums) lives
// in the database (supabase/migrations/20261105000100–0400); this module only
// formats and validates input.
import { z } from "zod";
import { detectImageType } from "@/lib/files/images";

export const CONVERSATION_KINDS = { direct: "Direct message", group: "Group", channel: "Channel", operation: "Operational workspace" } as const;
export type ConversationKind = keyof typeof CONVERSATION_KINDS;

/** Presence is what a person chose (or Away after inactivity); it says nothing about hours of service. */
export const PRESENCE = { available: "Available", busy: "Busy", away: "Away" } as const;
export type Presence = keyof typeof PRESENCE;

/**
 * Work status comes from Taviron's own records only: an active delivery (an
 * assignment whose load window is now) or approved time off. Taviron has no
 * work schedules, so it never claims someone is "working" or "off".
 */
export const WORK_STATUS = {
  active_delivery: "Active delivery",
  out_of_office: "Out of office",
  working_hours: "Working hours",
  outside_hours: "Outside working hours",
  unknown: "Unknown",
} as const;
export type WorkStatus = keyof typeof WORK_STATUS;

/** Shown wherever someone may be driving. Never a statement about compliance or availability. */
export const DRIVING_NOTICE = "Driver may be operating a vehicle. Do not expect an immediate response.";

/** Shown next to presence and work status so they are not mistaken for driver availability or hours of service. */
export const STATUS_DISCLAIMER =
  "Presence and work status are informational. They are not hours-of-service records and do not mean a driver is available for dispatch.";

export const PRIORITIES = { informational: "Informational", action_required: "Action required", critical: "Critical" } as const;
export type Priority = keyof typeof PRIORITIES;
export const PRIORITY_RANK: Record<Priority, number> = { informational: 1, action_required: 2, critical: 3 };
/** Critical uses the fixed red (never the company's brand colour). */
export const PRIORITY_TONE = { informational: "gray", action_required: "amber", critical: "critical" } as const;

export const ACK_SCOPES = { any: "One responsible recipient", all: "Every designated recipient" } as const;

/** Priorities a person may choose for an alert type: never below its safety minimum. */
export function allowedPriorities(minimum: Priority): Priority[] {
  return (Object.keys(PRIORITIES) as Priority[]).filter((p) => PRIORITY_RANK[p] >= PRIORITY_RANK[minimum]);
}

export const ALERT_EVENT_LABELS: Record<string, string> = {
  created: "Raised",
  occurred_again: "Occurred again",
  priority_changed: "Priority changed",
  acknowledged: "Acknowledged",
  escalated: "Escalated",
  escalation_canceled: "Escalation canceled",
  reassigned: "Reassigned",
  resolved: "Resolved",
  policy_changed: "Policy changed",
};

export const NOTIFICATION_CATEGORIES = {
  direct: "Direct messages",
  group: "Groups and workspaces",
  channel: "Channels",
  announcement: "Announcements",
  alert: "Alerts (Critical alerts always notify)",
} as const;

/** Mute choices in minutes (null = until turned back on). */
export const MUTE_CHOICES: Array<{ label: string; minutes: number | null }> = [
  { label: "1 hour", minutes: 60 },
  { label: "8 hours", minutes: 480 },
  { label: "1 day", minutes: 1440 },
  { label: "1 week", minutes: 10080 },
  { label: "Until I turn it back on", minutes: null },
];

/** The database stores an indefinite mute as 'infinity'. */
export function isMuted(mutedUntil: string | null, now = new Date()): boolean {
  if (!mutedUntil) return false;
  if (mutedUntil === "infinity") return true;
  return new Date(mutedUntil) > now;
}

/** "Muted until …", or "Muted" for an indefinite mute; null when not muted. */
export function muteLabel(mutedUntil: string | null, now = new Date(), timeZone?: string): string | null {
  if (!isMuted(mutedUntil, now)) return null;
  if (mutedUntil === "infinity") return "Muted";
  const until = new Date(mutedUntil as string);
  return `Muted until ${until.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })}`;
}

/** How often open Communications pages refresh (no realtime service is used). */
export const POLL_SECONDS = 10;

// -----------------------------------------------------------------------------
// Attachments
// -----------------------------------------------------------------------------
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** JPEG/PNG/WebP from their signatures, PDF from "%PDF-"; null for anything else. */
export function detectAttachmentType(bytes: Uint8Array): AttachmentType | null {
  const image = detectImageType(bytes);
  if (image) return image;
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
  return null;
}

export type AttachmentCheck = { ok: true; type: AttachmentType } | { ok: false; status: 400 | 413 | 415; error: string };

/** Size, real content type (from the bytes), and agreement with the declared type. */
export function checkAttachment(bytes: Uint8Array, declaredType: string): AttachmentCheck {
  if (bytes.length === 0) return { ok: false, status: 400, error: "The file is empty." };
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, status: 413, error: "A file must be 10 MB or smaller." };
  const type = detectAttachmentType(bytes);
  if (!type) return { ok: false, status: 415, error: "Only JPEG, PNG, WebP images or PDF files can be attached." };
  if (declaredType && declaredType !== type) return { ok: false, status: 415, error: "The file's content does not match its type." };
  return { ok: true, type };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// -----------------------------------------------------------------------------
// Input schemas (the database re-checks everything)
// -----------------------------------------------------------------------------
const id = z.uuid();

export const messageSchema = z.object({
  conversationId: id,
  body: z.string().trim().max(4000, "A message can be at most 4000 characters."),
  replyTo: id.nullable().default(null),
  clientKey: id,
  attachments: z.array(id).max(MAX_ATTACHMENTS_PER_MESSAGE, "At most 5 files per message.").default([]),
}).refine((v) => v.body.length > 0 || v.attachments.length > 0, { message: "Write a message.", path: ["body"] });

export const groupSchema = z.object({
  title: z.string().trim().max(120).default(""),
  members: z.array(id).min(1, "Choose at least one person."),
});

export const channelSchema = z.object({
  title: z.string().trim().min(2, "Name the channel.").max(120),
  description: z.string().trim().max(500).default(""),
  department: z.enum(["operations", "dispatch", "office", "shop", "sales", "management", "other"]).nullable().default(null),
  addDepartment: z.boolean().default(true),
  members: z.array(id).default([]),
});

export const announcementSchema = z.object({
  title: z.string().trim().min(3, "Give the announcement a title.").max(150),
  body: z.string().trim().min(1, "Write the announcement.").max(8000),
  department: z.enum(["operations", "dispatch", "office", "shop", "sales", "management", "other"]).nullable().default(null),
  requiresAck: z.boolean().default(false),
  clientKey: id,
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM.");
export const preferencesSchema = z.object({
  notify_direct: z.boolean(),
  notify_group: z.boolean(),
  notify_channel: z.boolean(),
  notify_announcement: z.boolean(),
  notify_alert: z.boolean(),
  quiet_start: hhmm.nullable(),
  quiet_end: hhmm.nullable(),
  timezone: z.string().trim().min(1).max(64),
}).refine((v) => (v.quiet_start === null) === (v.quiet_end === null), { message: "Set both the start and end of quiet hours, or neither.", path: ["quiet_end"] })
  .refine((v) => v.quiet_start === null || v.quiet_start !== v.quiet_end, { message: "Quiet hours must start and end at different times.", path: ["quiet_end"] });

export const settingsSchema = z.object({
  edit_window_minutes: z.coerce.number().int().min(0).max(1440),
  members_delete_own: z.boolean(),
  history_for_new_members: z.enum(["from_join", "full"]),
  retention_days: z.coerce.number().int().min(30).max(3650).nullable(),
  legal_hold: z.boolean(),
  away_after_minutes: z.coerce.number().int().min(5).max(240),
  delivery_notifications: z.enum(["notice", "defer"]),
  workspace_archive_hours: z.coerce.number().int().min(0).max(720),
});

export const workspaceScopeSchema = z.discriminatedUnion("scope_type", [
  z.object({ scope_type: z.literal("project"), order_ids: z.array(id).min(1, "Choose at least one order.") }),
  z.object({ scope_type: z.literal("destination"), site: z.string().trim().min(3, "Choose a destination."), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.") }),
  z.object({ scope_type: z.literal("loads"), load_ids: z.array(id).min(1, "Choose at least one load.") }),
]);
export type WorkspaceScope = z.infer<typeof workspaceScopeSchema>;

export const SCOPE_LABELS = {
  project: "Project (one or more orders)",
  destination: "Destination on a date",
  loads: "Selected loads",
} as const;
