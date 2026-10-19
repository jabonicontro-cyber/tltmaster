// Platform customer lifecycle (20261118000300): the shapes of public.platform_console(), platform_plans() and
// platform_lifecycle(), and how they are named. The database decides stages, prices and dates; this file only labels them.

export type LifecycleStage = "fee_due" | "onboarding" | "live" | "canceled";
export type LifecycleOffer = "standard" | "founding" | "free_beta";
export type LifecycleTerms = "monthly" | "annual";

export interface PlanVersion {
  id: string;
  plan_key: "essential" | "growth" | "professional" | "enterprise" | "custom";
  name: string;
  version: number;
  monthly_cents: number | null;
  onboarding_cents: number | null;
  from_price: boolean;
  trucks: number | null;
  bases: number | null;
  effective_from: string;
  note: string;
  created_at: string;
  companies: number;
  current: boolean;
}

export interface Lifecycle {
  stage: LifecycleStage;
  terms: LifecycleTerms;
  offer: LifecycleOffer;
  agreed_monthly_cents: number | null;
  onboarding_fee_cents: number | null;
  onboarding_fee_status: "due" | "paid" | "waived";
  onboarding_fee_note: string;
  go_live_on: string | null;
  live_at: string | null;
  commitment_start: string | null;
  canceled_at: string | null;
  cancel_reason: string;
  cancel_balance_cents: number | null;
  notes: string;
  updated_at: string;
  today: string;
  commitment_months_left: number | null;
  plan: Pick<PlanVersion, "id" | "plan_key" | "name" | "version" | "monthly_cents" | "onboarding_cents" | "from_price"> | null;
}

export interface Ack {
  at: string;
  note: string;
  by: string;
}

export interface Console {
  as_of: string;
  customers: { total: number; live: number; onboarding: number; fee_due: number; no_plan: number; canceled: number; go_live_14d: number };
  mrr: { cents: number; live: number; free: number; contracted_not_live_cents: number };
  pipeline: { open: number; new: number; demo_scheduled: number; overdue: number };
  acks: Record<string, Ack>;
  lifecycles: Record<string, { stage: LifecycleStage; go_live_on: string | null; agreed_monthly_cents: number | null; offer: LifecycleOffer }>;
}

export const STAGE_LABELS: Record<LifecycleStage, string> = {
  fee_due: "Onboarding fee due",
  onboarding: "Onboarding",
  live: "Live",
  canceled: "Canceled",
};

export const STAGE_TONES: Record<LifecycleStage, "amber" | "blue" | "green" | "gray"> = {
  fee_due: "amber",
  onboarding: "blue",
  live: "green",
  canceled: "gray",
};

export const OFFER_LABELS: Record<LifecycleOffer, string> = {
  standard: "Standard price",
  founding: "Founding customer (20% off)",
  free_beta: "Free beta (no monthly fee, onboarding fee waived)",
};

export const TERMS_LABELS: Record<LifecycleTerms, string> = {
  monthly: "Month to month",
  annual: "Annual commitment (12 months, 10% off)",
};

/**
 * The acknowledgement that applies to an attention item: one made after the item's problem started. An older
 * acknowledgement belongs to an earlier occurrence, so a recurring problem shows as new again.
 */
export function ackFor(acks: Record<string, Ack> | undefined, item: { kind: string; ref_id: string; since: string | null }): Ack | null {
  const a = acks?.[`${item.kind}:${item.ref_id}`];
  if (!a) return null;
  if (item.since && Date.parse(a.at) < Date.parse(item.since)) return null;
  return a;
}

/** Whole dollars and cents → cents, or null for an invalid amount ("" is null too). */
export function dollarsToCents(text: string): number | null {
  const t = text.trim().replace(/[$,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
