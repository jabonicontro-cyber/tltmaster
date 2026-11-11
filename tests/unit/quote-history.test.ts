import { describe, expect, it } from "vitest";
import { auditHistoryItem, quoteHistory, type QuoteAuditEntry, type QuoteStatusEvent } from "@/lib/quotes/history";

// A quote's History shows edits and new revisions next to status changes (owner walkthrough WK1).
const versions = [{ id: "v1", version_no: 1 }, { id: "v2", version_no: 2 }];
const audit = (o: Partial<QuoteAuditEntry>): QuoteAuditEntry => ({ id: "a1", occurred_at: "2026-11-02T10:00:00Z", actor_id: "u1", action: "quote.updated", summary: "", details: {}, ...o });

describe("quote history", () => {
  it("says what an edit changed, in plain words", () => {
    const item = auditHistoryItem(audit({ details: { version_id: "v1", total_cents: 123400, line_count: 2, pricing_override: true } }), (id) => versions.find((v) => v.id === id)?.version_no ?? null);
    expect(item).toMatchObject({ title: "Edited revision 1", note: "Total $1,234.00, 2 lines, a price differs from the price list" });
  });

  it("a new revision shows its number and the reason given", () => {
    const item = auditHistoryItem(audit({ action: "quote.revised", summary: "QTE-1001 revision 2 started: Customer asked for more tons", details: { from_version_id: "v1", to_version_id: "v2" } }), (id) => versions.find((v) => v.id === id)?.version_no ?? null);
    expect(item).toMatchObject({ title: "Revision 2 started", note: "Customer asked for more tons" });
  });

  it("status changes and edits together, newest first; created and sent are not repeated from the audit log", () => {
    const events: QuoteStatusEvent[] = [
      { id: "s1", from_status: null, to_status: "draft", note: "", actor_id: "u1", occurred_at: "2026-11-01T09:00:00Z" },
      { id: "s2", from_status: "draft", to_status: "sent", note: "", actor_id: "u1", occurred_at: "2026-11-03T09:00:00Z" },
    ];
    const h = quoteHistory(events, [
      audit({ id: "a0", action: "quote.created", occurred_at: "2026-11-01T09:00:00Z", details: { version_id: "v1" } }),
      audit({ id: "a1", occurred_at: "2026-11-02T10:00:00Z", details: { version_id: "v1", total_cents: 5000, line_count: 1 } }),
      audit({ id: "a2", action: "quote.marked_sent", occurred_at: "2026-11-03T09:00:00Z" }),
    ], versions);
    expect(h.map((x) => x.title)).toEqual(["Draft → Sent", "Edited revision 1", "Draft"]);
    expect(h[1]).toMatchObject({ note: "Total $50.00, 1 line", actorId: "u1" });
  });
});
