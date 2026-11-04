// Speed week by week (owner 2026-11-04): the planning and billing-ready figures per Monday-to-Sunday week, newest
// first, with the same minimums as the 30-day figures; weeks with too little are null, never zero.
import { describe, expect, it } from "vitest";
import { mondayOf, weeklySpeed } from "@/lib/command-center/speed";

const TZ = "America/Chicago";

describe("weeklySpeed", () => {
  it("finds the Monday of any day", () => {
    expect(mondayOf("2026-11-04")).toBe("2026-11-02"); // Wednesday
    expect(mondayOf("2026-11-02")).toBe("2026-11-02"); // Monday
    expect(mondayOf("2026-11-08")).toBe("2026-11-02"); // Sunday
  });

  it("measures each week on its own, newest first, and marks weeks with too little", () => {
    // Last week (Oct 26 – Nov 1): three delivery days planned the day before, 30 minutes from first to last truck.
    const plans = ["2026-10-27", "2026-10-28", "2026-10-29"].flatMap((d) => {
      const day = new Date(`${d}T12:00:00Z`);
      day.setUTCDate(day.getUTCDate() - 1);
      const before = day.toISOString().slice(0, 10);
      return [{ loadDate: d, createdAt: `${before}T20:00:00Z` }, { loadDate: d, createdAt: `${before}T20:30:00Z` }];
    });
    // This week: five tickets accepted two hours after delivery.
    const tickets = [1, 2, 3, 4, 5].map((i) => ({ deliveredAt: `2026-11-03T1${i}:00:00Z`, reviewedAt: `2026-11-03T1${i + 2}:00:00Z` }));
    const weeks = weeklySpeed(plans, tickets, TZ, "2026-11-04", 3);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-11-02", "2026-10-26", "2026-10-19"]);
    expect(weeks[0].planning).toBeNull();
    expect(weeks[0].billingReady).toMatchObject({ medianHours: 2, tickets: 5 });
    expect(weeks[1].planning).toMatchObject({ medianMinutes: 30, days: 3 });
    expect(weeks[1].billingReady).toBeNull();
    expect(weeks[2]).toMatchObject({ planning: null, billingReady: null });
  });

  it("returns nulls for a figure the person cannot see", () => {
    expect(weeklySpeed(null, null, TZ, "2026-11-04", 2).every((w) => w.planning === null && w.billingReady === null)).toBe(true);
  });
});
