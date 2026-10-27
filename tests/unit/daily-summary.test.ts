import { describe, expect, it } from "vitest";
import { summaryEmail, summaryLines, type DailySummary } from "@/lib/summary/daily";

// End-of-day summary (B97): short, counts only, zero lines left out.
const s: DailySummary = { day: "2026-10-27", loads: 12, delivered: 10, without_truck: 0, missing_tickets: 2, to_review: 1, trucks_down: 0, open_reports: 0, tomorrow_loads: 9, tomorrow_without_truck: 3 };

describe("daily summary", () => {
  it("lists only what needs saying", () => {
    expect(summaryLines(s)).toEqual([
      "Loads today: 10 of 12 delivered with a ticket",
      "2 assigned loads have no ticket yet",
      "1 ticket is waiting for review",
      "Tomorrow: 9 loads, 3 without a truck",
    ]);
  });

  it("builds a plain email with a link to the Command Center", () => {
    const e = summaryEmail("Top Line", s, "https://app.example.com/");
    expect(e.subject).toBe("Top Line: end of day, Tuesday, October 27");
    expect(e.text).toContain("- 2 assigned loads have no ticket yet");
    expect(e.text).toContain("https://app.example.com/command-center");
  });
});
