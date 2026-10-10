// Quote status rules. Mirrors private.quote_transition_allowed and the
// checks in public.revise_quote / public.save_quote_draft.

export const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "expired", "canceled"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

const TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ["canceled"],
  sent: ["accepted", "declined", "expired", "canceled"],
  declined: ["canceled"],
  expired: ["canceled"],
  accepted: ["canceled"],
  canceled: [],
};

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  canceled: "Canceled",
};

export function allowedTransitions(from: QuoteStatus): QuoteStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses that require a reason when chosen. */
export function transitionNeedsReason(to: QuoteStatus): boolean {
  return to === "declined" || to === "canceled";
}

export function canEditDraft(status: QuoteStatus, versionLocked: boolean): boolean {
  return status === "draft" && !versionLocked;
}

export function canRevise(status: QuoteStatus, versionLocked: boolean): boolean {
  return (status === "sent" || status === "declined" || status === "expired") && versionLocked;
}

export function canSend(status: QuoteStatus): boolean {
  return status === "draft" || status === "sent";
}

/** A sent quote whose expiration date has passed (dates as YYYY-MM-DD in business time). */
export function isPastExpiration(status: QuoteStatus, validUntil: string, today: string): boolean {
  return status === "sent" && validUntil < today;
}

/** A sent quote that has had no response for `followupDays` days. */
export function needsFollowUp(
  status: QuoteStatus,
  lastSentAt: string | null,
  now: Date,
  followupDays: number,
): boolean {
  if (status !== "sent" || !lastSentAt) return false;
  const ageMs = now.getTime() - new Date(lastSentAt).getTime();
  return ageMs >= followupDays * 24 * 60 * 60 * 1000;
}
