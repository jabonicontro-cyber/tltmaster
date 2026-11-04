// Support center (B138): case types, limits and labels shared by the office pages and the customer portal.

export const SUPPORT_KINDS = {
  delivery: "Delivery problem",
  billing: "Billing question",
  material: "Wrong material or quantity",
  other: "Other",
} as const;
export type SupportKind = keyof typeof SUPPORT_KINDS;
export const isSupportKind = (v: string): v is SupportKind => v in SUPPORT_KINDS;

/** Attachments: photos and PDFs, up to 5 per message, 10 MB each (the database checks the same). */
export const SUPPORT_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
export const SUPPORT_MAX_FILES = 5;
export const SUPPORT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_REOPEN_DAYS = 14;

export type SupportStatus = "open" | "answered" | "closed";
export const SUPPORT_STATUS_STAFF: Record<SupportStatus, string> = { open: "Needs a reply", answered: "Answered", closed: "Closed" };

/** Checks files before upload so the person hears about a wrong type or size before anything is sent. */
export function checkSupportFiles(files: Array<{ type: string; size: number }>): string | null {
  if (files.length > SUPPORT_MAX_FILES) return `Attach at most ${SUPPORT_MAX_FILES} files.`;
  if (files.some((f) => !SUPPORT_ACCEPT.split(",").includes(f.type))) return "Attach photos (JPEG, PNG, WebP) or PDFs only.";
  if (files.some((f) => f.size > SUPPORT_MAX_BYTES)) return "Each file can be at most 10 MB.";
  return null;
}

/** Hours past a first-reply target, or null when no target is set or the case is answered. */
export function hoursWaiting(createdAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / 3_600_000));
}
