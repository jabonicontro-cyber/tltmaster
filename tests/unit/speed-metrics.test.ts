import { describe, expect, it } from "vitest";
import { billingReadySpeed, minutesOfDay, planningSpeed, reviewPace } from "@/lib/command-center/speed";

const TZ = "America/Chicago";
// 2026-10-20 14:00 in Chicago (CDT, UTC-5) is 19:00 UTC.
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00-05:00`).toISOString();

describe("planningSpeed", () => {
  it("measures first to last assignment made the day before, as a median over days", () => {
    const rows = [
      // Deliveries on the 21st, planned on the 20th from 14:00 to 14:30.
      { loadDate: "2026-10-21", createdAt: at("2026-10-20", "14:00") },
      { loadDate: "2026-10-21", createdAt: at("2026-10-20", "14:30") },
      // The 22nd: 15:00 to 16:00.
      { loadDate: "2026-10-22", createdAt: at("2026-10-21", "15:00") },
      { loadDate: "2026-10-22", createdAt: at("2026-10-21", "16:00") },
      // The 23rd: 13:00 to 13:40, plus a same-day change that is not planning ahead.
      { loadDate: "2026-10-23", createdAt: at("2026-10-22", "13:00") },
      { loadDate: "2026-10-23", createdAt: at("2026-10-22", "13:40") },
      { loadDate: "2026-10-23", createdAt: at("2026-10-23", "09:00") },
    ];
    expect(planningSpeed(rows, TZ)).toEqual({ medianMinutes: 40, medianDoneAt: 14 * 60 + 30, days: 3 });
  });

  it("ignores days with one assignment or all recorded at the same moment, and needs three days", () => {
    const rows = [
      { loadDate: "2026-10-21", createdAt: at("2026-10-20", "14:00") },
      { loadDate: "2026-10-22", createdAt: at("2026-10-21", "15:00") },
      { loadDate: "2026-10-22", createdAt: at("2026-10-21", "15:00") },
      { loadDate: "2026-10-23", createdAt: at("2026-10-22", "13:00") },
      { loadDate: "2026-10-23", createdAt: at("2026-10-22", "13:20") },
    ];
    expect(planningSpeed(rows, TZ)).toBeNull();
  });
});

describe("billingReadySpeed", () => {
  it("is the median from delivery to acceptance, with the share within a day", () => {
    const d = at("2026-10-20", "08:00");
    const rows = [2, 4, 6, 30, 50].map((h) => ({ deliveredAt: d, reviewedAt: new Date(Date.parse(d) + h * 3_600_000).toISOString() }));
    expect(billingReadySpeed(rows)).toEqual({ medianHours: 6, withinDay: 0.6, tickets: 5 });
  });

  it("drops impossible rows and needs five tickets", () => {
    const d = at("2026-10-20", "08:00");
    const rows = [1, 2, 3, 4].map((h) => ({ deliveredAt: d, reviewedAt: new Date(Date.parse(d) + h * 3_600_000).toISOString() }));
    rows.push({ deliveredAt: d, reviewedAt: at("2026-10-19", "08:00") });
    expect(billingReadySpeed(rows)).toBeNull();
  });
});

describe("reviewPace", () => {
  const start = Date.parse(at("2026-10-20", "09:00"));
  const t = (seconds: number) => new Date(start + seconds * 1000).toISOString();

  it("times each review by the gap since the person's previous one in the same sitting", () => {
    // One person: a review every 30 s for 11 reviews (10 timed, 5 minutes) → 2 per minute.
    const rows = Array.from({ length: 11 }, (_, i) => ({ reviewer: "a", reviewedAt: t(i * 30) }));
    expect(reviewPace(rows)).toEqual({ perMinute: 2, timed: 10, minutes: 5, sittings: 1 });
  });

  it("does not time batches, a sitting's first review or gaps across sittings", () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => ({ reviewer: "a", reviewedAt: t(i * 60) })), // 10 timed, 10 min
      ...Array.from({ length: 20 }, (_, i) => ({ reviewer: "a", reviewedAt: t(3600 + i * 0.05) })), // a batch an hour later
      ...Array.from({ length: 3 }, (_, i) => ({ reviewer: "b", reviewedAt: t(i * 120) })), // 2 timed, 4 min
    ];
    expect(reviewPace(rows)).toEqual({ perMinute: 0.9, timed: 12, minutes: 14, sittings: 2 });
  });

  it("shows nothing until enough review time is measured", () => {
    expect(reviewPace(Array.from({ length: 50 }, (_, i) => ({ reviewer: "seed", reviewedAt: t(i * 0.01) })))).toBeNull();
  });
});

describe("minutesOfDay", () => {
  it("reads the time in the business zone", () => {
    expect(minutesOfDay(at("2026-10-20", "14:30"), TZ)).toBe(14 * 60 + 30);
  });
});
