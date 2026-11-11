import { describe, expect, it } from "vitest";
import { activityLabel, quoteLastActivity, sortByActivity, type QuoteActivityInput } from "@/lib/quotes/activity";

// The Quotes list is sorted by most recent activity, never by number (owner walkthrough WK1).
const q = (o: Partial<QuoteActivityInput> & { quote_number: string }): QuoteActivityInput => ({
  id: o.quote_number, status: "draft", created_at: "2026-09-01T12:00:00Z", last_sent_at: null, accepted_at: null, closed_at: null, edited_at: null, ...o,
});

describe("a quote's most recent activity", () => {
  it("is the latest recorded step: created, edited, sent, accepted or closed", () => {
    expect(quoteLastActivity(q({ quote_number: "Q1" }))).toEqual({ at: "2026-09-01T12:00:00Z", kind: "created" });
    // A new draft's first save happens in the same moment it is created: still "Created".
    expect(quoteLastActivity(q({ quote_number: "Q1", edited_at: "2026-09-01T12:00:00Z" })).kind).toBe("created");
    expect(quoteLastActivity(q({ quote_number: "Q1", edited_at: "2026-09-03T08:00:00Z" })).kind).toBe("edited");
    expect(quoteLastActivity(q({ quote_number: "Q1", status: "sent", last_sent_at: "2026-09-05T08:00:00Z", edited_at: "2026-09-03T08:00:00Z" })).kind).toBe("sent");
    expect(quoteLastActivity(q({ quote_number: "Q1", status: "accepted", last_sent_at: "2026-09-05T08:00:00Z", accepted_at: "2026-09-09T08:00:00Z" })).kind).toBe("accepted");
    // A revision started after sending (an unsent revision being edited) is newer than the send.
    expect(quoteLastActivity(q({ quote_number: "Q1", status: "draft", last_sent_at: "2026-09-05T08:00:00Z", edited_at: "2026-09-07T08:00:00Z" })).kind).toBe("edited");
  });

  it("names how a closed quote closed", () => {
    const closed = { at: "2026-09-10T00:00:00Z", kind: "closed" as const };
    expect([activityLabel(closed, "declined"), activityLabel(closed, "expired"), activityLabel(closed, "canceled")]).toEqual(["Declined", "Expired", "Canceled"]);
  });
});

describe("sorting the list", () => {
  it("puts the most recent activity first, not the highest or lowest number", () => {
    const rows = sortByActivity([
      q({ quote_number: "QTE-1001", created_at: "2026-08-01T12:00:00Z", status: "accepted", last_sent_at: "2026-08-02T12:00:00Z", accepted_at: "2026-11-10T09:00:00Z" }),
      q({ quote_number: "QTE-1002", created_at: "2026-11-01T12:00:00Z" }),
      q({ quote_number: "QTE-1003", created_at: "2026-10-01T12:00:00Z", status: "declined", last_sent_at: "2026-10-02T12:00:00Z", closed_at: "2026-10-05T12:00:00Z" }),
      q({ quote_number: "QTE-1004", created_at: "2026-11-05T12:00:00Z", edited_at: "2026-11-11T07:00:00Z" }),
    ]);
    expect(rows.map((r) => r.quote_number)).toEqual(["QTE-1004", "QTE-1001", "QTE-1002", "QTE-1003"]);
    expect(rows[1].activity).toEqual({ at: "2026-11-10T09:00:00Z", kind: "accepted" });
  });

  it("the same moment falls back to the newer quote number (numeric order)", () => {
    const at = "2026-11-01T12:00:00Z";
    expect(sortByActivity([q({ quote_number: "QTE-999", created_at: at }), q({ quote_number: "QTE-1000", created_at: at })]).map((r) => r.quote_number)).toEqual(["QTE-1000", "QTE-999"]);
  });
});
