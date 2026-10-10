import { describe, expect, it } from "vitest";
import {
  allowedTransitions, canEditDraft, canRevise, canSend, canTransition, isPastExpiration, needsFollowUp,
  QUOTE_STATUSES,
} from "@/lib/quotes/status";

describe("quote status rules", () => {
  it("never allows leaving canceled", () => {
    expect(allowedTransitions("canceled")).toEqual([]);
  });
  it("only sent quotes can be accepted or declined", () => {
    for (const s of QUOTE_STATUSES) {
      expect(canTransition(s, "accepted")).toBe(s === "sent");
      expect(canTransition(s, "declined")).toBe(s === "sent");
    }
  });
  it("drafts are editable only while unlocked", () => {
    expect(canEditDraft("draft", false)).toBe(true);
    expect(canEditDraft("draft", true)).toBe(false);
    expect(canEditDraft("sent", true)).toBe(false);
  });
  it("revisions start from issued sent/declined/expired versions", () => {
    expect(canRevise("sent", true)).toBe(true);
    expect(canRevise("declined", true)).toBe(true);
    expect(canRevise("expired", true)).toBe(true);
    expect(canRevise("accepted", true)).toBe(false);
    expect(canRevise("draft", false)).toBe(false);
  });
  it("send is available for draft and sent", () => {
    expect(canSend("draft")).toBe(true);
    expect(canSend("sent")).toBe(true);
    expect(canSend("accepted")).toBe(false);
  });
  it("flags past-expiration and follow-up", () => {
    expect(isPastExpiration("sent", "2026-01-01", "2026-01-02")).toBe(true);
    expect(isPastExpiration("sent", "2026-01-02", "2026-01-02")).toBe(false);
    expect(isPastExpiration("accepted", "2026-01-01", "2026-01-02")).toBe(false);
    const now = new Date("2026-01-10T12:00:00Z");
    expect(needsFollowUp("sent", "2026-01-06T12:00:00Z", now, 3)).toBe(true);
    expect(needsFollowUp("sent", "2026-01-09T12:00:00Z", now, 3)).toBe(false);
    expect(needsFollowUp("draft", "2026-01-01T12:00:00Z", now, 3)).toBe(false);
  });
});
