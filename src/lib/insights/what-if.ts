/**
 * "What if" planner (B123): scenarios from the company's own last 90 days. Nothing is changed; every result is an
 * estimate built from averages, and says which averages it used.
 */

export interface Baseline {
  days: number;
  /** Loads per truck-day: loads ÷ days trucks had loads. */
  loadsPerTruckDay: number | null;
  /** Working days in the period: the most days any truck had loads. */
  workingDays: number;
  /** Average revenue per costed load and average profit per costed load (null without cost rates). */
  revenuePerLoadCents: number | null;
  profitPerLoadCents: number | null;
}

export function baselineFrom(fleet: Array<{ loads: number; days_with_loads: number }>, profit: { loads_costed: number; revenue_cents: number; cost_cents: number; has_rates: boolean } | null, days: number): Baseline {
  const loads = fleet.reduce((n, t) => n + t.loads, 0);
  const truckDays = fleet.reduce((n, t) => n + t.days_with_loads, 0);
  const workingDays = fleet.reduce((m, t) => Math.max(m, t.days_with_loads), 0);
  const costed = profit && profit.loads_costed > 0 ? profit.loads_costed : 0;
  return {
    days,
    loadsPerTruckDay: truckDays > 0 ? loads / truckDays : null,
    workingDays,
    revenuePerLoadCents: costed ? Math.round(profit!.revenue_cents / costed) : null,
    profitPerLoadCents: costed && profit!.has_rates ? Math.round((profit!.revenue_cents - profit!.cost_cents) / costed) : null,
  };
}

export interface TruckScenario { extraLoadsPerMonth: number; extraRevenueCents: number | null; extraProfitCents: number | null }

/** Adding trucks that work like the current fleet, if there is work for them: per 30 days. */
export function addTrucks(b: Baseline, trucks: number): TruckScenario | null {
  if (!b.loadsPerTruckDay || b.workingDays === 0 || trucks <= 0) return null;
  const daysPerMonth = (b.workingDays / b.days) * 30;
  const extra = Math.round(trucks * b.loadsPerTruckDay * daysPerMonth);
  return {
    extraLoadsPerMonth: extra,
    extraRevenueCents: b.revenuePerLoadCents === null ? null : extra * b.revenuePerLoadCents,
    extraProfitCents: b.profitPerLoadCents === null ? null : extra * b.profitPerLoadCents,
  };
}

/** A rate change on one customer, assuming they order the same amount: per 30 days. */
export function rateChange(customerRevenueCents: number, days: number, percent: number): number {
  return Math.round((customerRevenueCents * (percent / 100) * 30) / days);
}
