// Proposed pricing shown on the public website. A proposal, not an offer:
// every figure is subject to confirmation in a written agreement, and nothing
// is charged through the website. Change the numbers here only.
export const PRICING = {
  baseMonthlyCents: 49_900,
  foundingDiscountPercent: 20,
  foundingCustomerLimit: 10,
} as const;

export function foundingMonthlyCents(p: { baseMonthlyCents: number; foundingDiscountPercent: number } = PRICING): number {
  return Math.round((p.baseMonthlyCents * (100 - p.foundingDiscountPercent)) / 100);
}

export function usd(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
}
