import { usd } from "@/lib/site/pricing";

/**
 * Revenue over time (PC2, public.platform_revenue_by_month, 20261120022400): AGREED monthly amounts as recorded, never
 * money collected (there is no payment system). Each month is the position at its last day; the current month is today.
 */
export interface RevenueCompany { id: string; name: string; cents: number | null; canceled?: boolean }
export interface RevenueMonth {
  month: string; // YYYY-MM
  month_start: string;
  month_end: string;
  current: boolean;
  customers: number;
  paying: number;
  free: number;
  not_recorded: number;
  agreed_cents: number;
  change_cents: number | null;
  new: RevenueCompany[];
  lost: RevenueCompany[];
}
export interface RevenueRenewal { company_id: string; name: string; renews_on: string; days: number; agreed_monthly_cents: number | null; renewal_off: boolean; plan: string | null }
export interface RevenueScheduledChange { company_id: string; name: string; effective_on: string; agreed_monthly_cents: number; current_cents: number | null; plan: string | null }
export interface RevenueReport {
  as_of: string;
  first_month: string;
  months: RevenueMonth[];
  renewals: RevenueRenewal[];
  scheduled_changes: RevenueScheduledChange[];
  not_live_yet: { companies: number; agreed_cents: number };
}

export const REVENUE_RANGES = [6, 12, 24] as const;
export type RevenueRange = (typeof REVENUE_RANGES)[number];

/** The months to show from ?months=; anything else is 12. */
export function revenueRange(value: string | string[] | undefined): RevenueRange {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return (REVENUE_RANGES as readonly number[]).includes(n) ? (n as RevenueRange) : 12;
}

/** "Nov 2026" from "2026-11". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** "+$250", "−$999", "No change", or "–" when there is no month before to compare with. */
export function changeText(cents: number | null): string {
  if (cents === null || cents === undefined) return "–";
  if (cents === 0) return "No change";
  return `${cents > 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

/** Up to three names, then "and N more". */
export function namesText(list: RevenueCompany[], max = 3): string {
  if (!list.length) return "";
  const shown = list.slice(0, max).map((c) => c.name);
  return list.length > max ? `${shown.join(", ")} and ${list.length - max} more` : shown.join(", ");
}

/** Bar heights for the chart, 0–100, against the largest month (an empty history is all zero, never divided by 0). */
export function barHeights(months: Pick<RevenueMonth, "agreed_cents">[]): number[] {
  const max = Math.max(0, ...months.map((m) => m.agreed_cents));
  return months.map((m) => (max > 0 ? Math.round((m.agreed_cents / max) * 100) : 0));
}

/** One line under the month's customer count: paying, free and not recorded, only the parts that apply. */
export function customersSubText(m: Pick<RevenueMonth, "paying" | "free" | "not_recorded">): string {
  const parts = [m.paying ? `${m.paying} paying` : "", m.free ? `${m.free} free` : "", m.not_recorded ? `${m.not_recorded} amount not recorded` : ""].filter(Boolean);
  return parts.join(" · ");
}
