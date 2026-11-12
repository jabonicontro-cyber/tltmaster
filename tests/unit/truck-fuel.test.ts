import { describe, expect, it } from "vitest";
import { truckFuelSummary } from "@/lib/fuel/truck-fuel";

// The truck's "Costs and utilization" card shows the fuel actually bought for it (Fuel and IFTA receipts), WK1.
describe("fuel bought for one truck", () => {
  it("adds up the live receipts and leaves voided ones out", () => {
    const s = truckFuelSummary([
      { purchased_on: "2026-10-02", gallons: 101.4, total_cents: 39_520, voided: false },
      { purchased_on: "2026-09-12", gallons: 98.25, total_cents: 38_100, voided: false },
      { purchased_on: "2026-10-20", gallons: 500, total_cents: 200_000, voided: true },
    ]);
    expect(s).toEqual({ receipts: 2, gallons: 199.7, cents: 77_620, from: "2026-09-12", to: "2026-10-02" });
  });

  it("no receipts is none recorded, never an amount", () => {
    expect(truckFuelSummary([])).toEqual({ receipts: 0, gallons: 0, cents: 0, from: null, to: null });
    expect(truckFuelSummary([{ purchased_on: "2026-10-02", gallons: 10, total_cents: 4000, voided: true }]).receipts).toBe(0);
  });

  it("without the amounts (no billing access, SEC5) it has gallons and no amount, never a partial total", () => {
    expect(truckFuelSummary([
      { purchased_on: "2026-10-02", gallons: 101.4, total_cents: null, voided: false },
      { purchased_on: "2026-09-12", gallons: 98.25, total_cents: null, voided: false },
    ])).toEqual({ receipts: 2, gallons: 199.7, cents: null, from: "2026-09-12", to: "2026-10-02" });
    expect(truckFuelSummary([
      { purchased_on: "2026-10-02", gallons: 10, total_cents: 4000, voided: false },
      { purchased_on: "2026-10-03", gallons: 10, total_cents: null, voided: false },
    ]).cents).toBeNull();
  });
});
