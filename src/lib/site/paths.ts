// The public website: pages anyone may read, even while the early-access gate
// is on. Exact paths only — nothing below them, and only GET/HEAD, so no
// server action or app route is ever reachable through a public page.
export const SITE_PAGES = ["/", "/platform", "/solutions", "/pricing", "/about", "/contact", "/demo", "/privacy", "/terms"] as const;
export type SitePage = (typeof SITE_PAGES)[number];

/** The one public endpoint that accepts data: the demo/contact form (POST only). */
export const LEAD_ENDPOINT = "/api/leads";

/** Search engines may only ever index these (when SITE_INDEXING=on). */
export const INDEXABLE_PAGES: readonly string[] = SITE_PAGES;

function normalize(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Whether a request is part of the public website (never needs sign-in; skips
 * the early-access gate only when the site is enabled, PUBLIC_SITE=on).
 */
export function isPublicSiteRequest(path: string, method: string, enabled = true): boolean {
  if (!enabled) return false;
  const p = normalize(path);
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return (SITE_PAGES as readonly string[]).includes(p);
  return m === "POST" && p === LEAD_ENDPOINT;
}
