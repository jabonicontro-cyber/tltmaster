// Fuel bought for one truck (Fuel and IFTA, B130), for the truck's "Costs and utilization" card (owner walkthrough WK1:
// the card said fuel was not tracked although fuel receipts exist). Only recorded receipts: voided ones are left out,
// nothing is estimated, and no receipts means "none recorded", never $0 of fuel.

// What fuel cost is money (owner 2026-11-12, SEC5): total_cents is null when the person may not see it (no billing.view),
// and then the summary has no amount at all (cents null), never a partial or $0 total.
export interface TruckFuelPurchase { purchased_on: string; gallons: number; total_cents: number | null; voided: boolean }

export interface TruckFuelSummary {
  receipts: number;
  gallons: number;
  /** What the live receipts cost; null when any of their amounts was not read (not shown to this person). */
  cents: number | null;
  /** First and last purchase dates among the receipts counted; null when there are none. */
  from: string | null;
  to: string | null;
}

export function truckFuelSummary(purchases: readonly TruckFuelPurchase[]): TruckFuelSummary {
  const live = purchases.filter((p) => !p.voided);
  const dates = live.map((p) => p.purchased_on).sort();
  return {
    receipts: live.length,
    // Gallons to a tenth, as receipts show them; cents exactly.
    gallons: Math.round(live.reduce((n, p) => n + Number(p.gallons), 0) * 10) / 10,
    cents: live.some((p) => p.total_cents === null) ? null : live.reduce((n, p) => n + Number(p.total_cents), 0),
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };
}
