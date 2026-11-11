// The Quotes list is sorted by each quote's most recent activity (owner walkthrough WK1: it read as sorted by number).
// Activity is only what the records hold, each with its own time: created, an unsent revision edited, sent (or marked
// sent), accepted, or closed (declined, expired, canceled). An issued revision cannot change, so only an unsent one's
// last save counts as an edit. quotes.updated_at is not used: it also moves when nothing a person did changed (a
// demo's sample dates, for instance), so it would not say what happened.

export type QuoteActivityKind = "created" | "edited" | "sent" | "accepted" | "closed";

export interface QuoteActivityInput {
  id: string;
  quote_number: string;
  status: string;
  created_at: string;
  last_sent_at: string | null;
  accepted_at: string | null;
  /** quotes.closed_at: declined, expired or canceled. */
  closed_at?: string | null;
  /** The last save of the quote's unsent revision (quote_versions.updated_at where locked_at is null). */
  edited_at?: string | null;
}

export interface QuoteActivity { at: string; kind: QuoteActivityKind }

/** The most recent recorded activity of one quote. Equal times: the later step in the quote's life wins. */
export function quoteLastActivity(q: QuoteActivityInput): QuoteActivity {
  const candidates: Array<QuoteActivity | null> = [
    { at: q.created_at, kind: "created" },
    // Saved after it was created (a new draft's first save carries the creation time: that is "Created").
    q.edited_at && Date.parse(q.edited_at) > Date.parse(q.created_at) ? { at: q.edited_at, kind: "edited" } : null,
    q.last_sent_at ? { at: q.last_sent_at, kind: "sent" } : null,
    q.accepted_at ? { at: q.accepted_at, kind: "accepted" } : null,
    q.closed_at ? { at: q.closed_at, kind: "closed" } : null,
  ];
  let best: QuoteActivity = candidates[0]!;
  for (const c of candidates) if (c && Date.parse(c.at) >= Date.parse(best.at)) best = c;
  return best;
}

/** Most recent activity first; the same moment falls back to the higher quote number (the newer quote). */
export function sortByActivity<T extends QuoteActivityInput>(rows: readonly T[]): Array<T & { activity: QuoteActivity }> {
  return rows
    .map((r) => ({ ...r, activity: quoteLastActivity(r) }))
    .sort((a, b) => Date.parse(b.activity.at) - Date.parse(a.activity.at) || b.quote_number.localeCompare(a.quote_number, "en", { numeric: true }));
}

/** Plain words for the activity column ("Sent", "Edited"…); a closed quote says how it closed. */
export function activityLabel(a: QuoteActivity, status: string): string {
  switch (a.kind) {
    case "created": return "Created";
    case "edited": return "Edited";
    case "sent": return "Sent";
    case "accepted": return "Accepted";
    case "closed": return status === "declined" ? "Declined" : status === "expired" ? "Expired" : status === "canceled" ? "Canceled" : "Closed";
  }
}

/** The sort, said on the page above the list. */
export const QUOTE_SORT_LABEL = "Most recent activity first: created, edited, sent, accepted or closed.";
