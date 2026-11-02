import { describe, expect, it } from "vitest";
import { addTrucks, baselineFrom, rateChange } from "@/lib/insights/what-if";

describe("what if", () => {
  const fleet = [{ loads: 120, days_with_loads: 60 }, { loads: 60, days_with_loads: 30 }];
  const profit = { loads_costed: 150, revenue_cents: 15_000_000, cost_cents: 9_000_000, has_rates: true };

  it("builds averages from the last 90 days", () => {
    expect(baselineFrom(fleet, profit, 90)).toEqual({ days: 90, loadsPerTruckDay: 2, workingDays: 60, revenuePerLoadCents: 100_000, profitPerLoadCents: 40_000 });
    expect(baselineFrom([], null, 90)).toMatchObject({ loadsPerTruckDay: null, revenuePerLoadCents: null, profitPerLoadCents: null });
    expect(baselineFrom(fleet, { ...profit, has_rates: false }, 90).profitPerLoadCents).toBeNull();
  });

  it("adds trucks at the fleet's own pace, per 30 days", () => {
    const b = baselineFrom(fleet, profit, 90);
    expect(addTrucks(b, 1)).toEqual({ extraLoadsPerMonth: 40, extraRevenueCents: 4_000_000, extraProfitCents: 1_600_000 });
    expect(addTrucks(b, 0)).toBeNull();
    expect(addTrucks(baselineFrom([], null, 90), 1)).toBeNull();
  });

  it("prices a rate change per 30 days", () => {
    expect(rateChange(9_000_000, 90, 5)).toBe(150_000);
    expect(rateChange(9_000_000, 90, -10)).toBe(-300_000);
  });
});
