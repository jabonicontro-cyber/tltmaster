/**
 * Customer site directions verification (master plan B51; migration 20261115000200). Mirrors
 * private.site_directions_status so pages can show the same answer the database gives drivers.
 *
 * - none: the site has no directions.
 * - unverified: nobody has confirmed them (new sites, and any site whose directions changed since).
 * - due: verified, but longer ago than the company's review interval for that kind of site.
 * - verified: confirmed within the interval, or the company set no interval for that kind.
 *
 * Taviron sets no interval of its own: the company chooses one per kind in Settings (empty = none).
 */

export type DirectionsRisk = "standard" | "safety_access";
export type DirectionsStatus = "none" | "unverified" | "due" | "verified";

export const DIRECTIONS_RISK_LABELS: Record<DirectionsRisk, string> = {
  standard: "Standard",
  safety_access: "Safety or access critical",
};

export interface ReviewIntervals {
  site_review_days_standard: number | null;
  site_review_days_safety: number | null;
}

export interface SiteDirections {
  directions: string | null;
  directions_risk: DirectionsRisk;
  directions_verified_at: string | null;
}

const DAY_MS = 86_400_000;

export function reviewDays(risk: DirectionsRisk, intervals: ReviewIntervals): number | null {
  return risk === "safety_access" ? intervals.site_review_days_safety : intervals.site_review_days_standard;
}

export function directionsStatus(site: SiteDirections, intervals: ReviewIntervals, now: number = Date.now()): DirectionsStatus {
  if (!site.directions?.trim()) return "none";
  if (!site.directions_verified_at) return "unverified";
  const days = reviewDays(site.directions_risk, intervals);
  if (days !== null && new Date(site.directions_verified_at).getTime() < now - days * DAY_MS) return "due";
  return "verified";
}

/**
 * Whether drivers and dispatch should be warned. Unverified or overdue safety/access directions always are; standard
 * directions only once overdue (a new standard site without verification is shown as "not verified" without a warning).
 */
export function directionsNeedAttention(status: DirectionsStatus | null | undefined, risk: DirectionsRisk): boolean {
  if (status === "due") return true;
  return status === "unverified" && risk === "safety_access";
}
