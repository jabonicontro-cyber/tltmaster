// Public Taviron pricing (founder's tiers, master plan §5.1). Per company, per
// month, before applicable taxes; confirmed in the written service agreement.
// Nothing is charged through the website. Founding-customer discounts are
// private and deliberately not in this file. Change the numbers here only.

export interface Tier {
  key: "essential" | "growth" | "professional" | "enterprise";
  name: string;
  monthlyCents: number;
  /** "From" price (Enterprise). */
  from?: boolean;
  trucks: number;
  bases: number;
  onboardingCents: number;
}

export const TIERS: Tier[] = [
  { key: "essential", name: "Essential", monthlyCents: 49_900, trucks: 25, bases: 1, onboardingCents: 19_900 },
  { key: "growth", name: "Growth", monthlyCents: 74_900, trucks: 50, bases: 2, onboardingCents: 29_900 },
  { key: "professional", name: "Professional", monthlyCents: 99_900, trucks: 75, bases: 3, onboardingCents: 39_900 },
  { key: "enterprise", name: "Enterprise", monthlyCents: 149_900, from: true, trucks: 100, bases: 5, onboardingCents: 59_900 },
];

export const CUSTOM = { onboardingFromCents: 59_900, aboveTrucks: 100 } as const;

/** Annual commitment: 12 months paid monthly, 10% off the standard price. */
export const ANNUAL_DISCOUNT_PERCENT = 10;
export const EXTRA_TRAINING_CENTS = 4_900;

export function annualMonthlyCents(monthlyCents: number): number {
  return Math.round((monthlyCents * (100 - ANNUAL_DISCOUNT_PERCENT)) / 100);
}

/** The lowest tier that covers both the truck count and the dispatch-base count, or null (Custom). */
export function tierFor(trucks: number, bases: number): Tier | null {
  return TIERS.find((t) => trucks <= t.trucks && bases <= t.bases) ?? null;
}

export function usd(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
}
