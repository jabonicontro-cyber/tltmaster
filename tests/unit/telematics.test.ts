import { describe, expect, it } from "vitest";
import { feedHosProvider, hosApprovalAllowed } from "@/lib/hos";
import { ageLabel, clockLabel, hoursVerified, isStale, parseClock, parseStatus, type HoursRecord } from "@/lib/telematics";

const now = new Date("2026-11-01T15:00:00Z");
const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const rec = (over: Partial<HoursRecord> = {}): HoursRecord => ({ driverId: "d1", asOf: ago(10), dutyStatus: "driving", driveLeft: 300, shiftLeft: 400, cycleLeft: 3000, source: "feed", ...over });
const FEED = { source: "feed" as const, staleMinutes: 30 };
const TODAY = "2026-11-01";

describe("GPS and hours helpers", () => {
  it("labels age, clocks and staleness", () => {
    expect(ageLabel(ago(0), now)).toBe("Just now");
    expect(ageLabel(ago(12), now)).toBe("12 min ago");
    expect(ageLabel(ago(125), now)).toBe("2 h 5 min ago");
    expect(ageLabel(ago(60 * 50), now)).toBe("2 days ago");
    expect(clockLabel(312)).toBe("5 h 12 min");
    expect(clockLabel(45)).toBe("45 min");
    expect(clockLabel(null)).toBeNull();
    expect(isStale(ago(31), 30, now)).toBe(true);
    expect(isStale(ago(30), 30, now)).toBe(false);
  });

  it("reads clock input and the status", () => {
    expect(parseClock("5:30", 24)).toBe(330);
    expect(parseClock("11", 24)).toBe(660);
    expect(parseClock("", 24)).toBeNull();
    expect(parseClock("25", 24)).toBe("bad");
    expect(parseClock("5:75", 24)).toBe("bad");
    expect(parseStatus(null)).toMatchObject({ source: "none", staleMinutes: 30 });
    expect(parseStatus({ source: "feed", stale_minutes: 45, feed_key_hint: "ab12" })).toMatchObject({ source: "feed", staleMinutes: 45, feedKeyHint: "ab12" });
  });

  it("verifies hours only from a current feed, for today, with drive and shift time left", () => {
    expect(hoursVerified(rec(), FEED, TODAY, TODAY, now)).toBe(true);
    expect(hoursVerified(rec({ source: "manual" }), FEED, TODAY, TODAY, now)).toBe(false);
    expect(hoursVerified(rec({ source: "demo" }), FEED, TODAY, TODAY, now)).toBe(false);
    expect(hoursVerified(rec(), { source: "manual", staleMinutes: 30 }, TODAY, TODAY, now)).toBe(false);
    expect(hoursVerified(rec({ asOf: ago(45) }), FEED, TODAY, TODAY, now)).toBe(false);
    expect(hoursVerified(rec(), FEED, "2026-11-02", TODAY, now)).toBe(false);
    expect(hoursVerified(rec({ driveLeft: 0 }), FEED, TODAY, TODAY, now)).toBe(false);
    expect(hoursVerified(rec({ shiftLeft: null }), FEED, TODAY, TODAY, now)).toBe(false);
    expect(hoursVerified(undefined, FEED, TODAY, TODAY, now)).toBe(false);
  });

  it("the feed provider uses each driver's latest record; without a feed the dispatcher must confirm", () => {
    const p = feedHosProvider([rec({ asOf: ago(20), driveLeft: 0 }), rec({ asOf: ago(5) }), rec({ driverId: "d2", source: "manual" })], FEED, TODAY, now);
    expect(p.source).toBe("feed");
    expect(p.verified("d1", TODAY)).toBe(true);
    expect(p.verified("d2", TODAY)).toBe(false);
    expect(hosApprovalAllowed(p, ["d1"], TODAY, false)).toBe(true);
    expect(hosApprovalAllowed(p, ["d1", "d2"], TODAY, false)).toBe(false);
    expect(hosApprovalAllowed(p, ["d1", "d2"], TODAY, true)).toBe(true);
    expect(feedHosProvider([rec()], { source: "manual", staleMinutes: 30 }, TODAY, now).verified("d1", TODAY)).toBe(false);
  });
});
