import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Early-access gate configuration (server only).
 *
 * EARLY_ACCESS_GATE  "on" | "off". Default: on in production builds, off in
 *                    development. When on, SITE_ACCESS_SECRET is required and
 *                    the app refuses every request until it is set (fail closed).
 * SITE_ACCESS_SECRET at least 32 random characters; signs the access cookie.
 *                    Rotating it signs every device out of early access.
 * EARLY_ACCESS_DAYS  how long a device stays admitted (1–90, default 30; never
 *                    beyond the code's own expiry).
 */
export function siteGate(): { enabled: boolean; secret: string | null; days: number } {
  const flag = (process.env.EARLY_ACCESS_GATE ?? "").trim().toLowerCase();
  const enabled = flag ? flag !== "off" : process.env.NODE_ENV === "production";
  const raw = (process.env.SITE_ACCESS_SECRET ?? "").trim();
  const days = Math.min(Math.max(Number.parseInt(process.env.EARLY_ACCESS_DAYS ?? "30", 10) || 30, 1), 90);
  return { enabled, secret: raw.length >= 32 ? raw : null, days };
}

/**
 * Re-check the grant with the database at most this often; revocation takes
 * effect within it. EARLY_ACCESS_RECHECK_SECONDS (0–3600, default 300).
 */
export function revalidateSeconds(): number {
  const v = Number.parseInt(process.env.EARLY_ACCESS_RECHECK_SECONDS ?? "300", 10);
  return Number.isFinite(v) ? Math.min(Math.max(v, 0), 3600) : 300;
}
/** If the database cannot be reached, keep a recently confirmed grant for at most this long. */
export const OFFLINE_GRACE_SECONDS = 3600;

/** `__Host-` cookies must be Secure, host-only and Path=/ — used whenever the request is HTTPS. */
export function accessCookieName(secure: boolean): string {
  return secure ? "__Host-taviron-access" : "taviron-access";
}

/**
 * Whether the public website (marketing pages and the demo/contact form) is
 * open to everyone while the gate is on. Off unless PUBLIC_SITE=on: making the
 * site public is the owner's decision, not a side effect of a deploy.
 */
export function publicSiteEnabled(): boolean {
  return (process.env.PUBLIC_SITE ?? "").trim().toLowerCase() === "on";
}

/** Paths reachable without early access: the gate itself and Supabase Auth email links (one-time tokens). */
const EXEMPT = ["/early-access", "/auth/confirm", "/auth/callback", "/auth/error"];
export function isGateExempt(path: string): boolean {
  return EXEMPT.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Ask the database whether a grant is still valid. null = the check could not be made. */
export async function revalidateGrant(grantId: string): Promise<{ valid: boolean; expiresAt?: string } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await admin.rpc("site_access_validate", { p_grant_id: grantId });
    if (error || !data) return null;
    const r = data as { valid: boolean; expires_at?: string };
    return { valid: r.valid, expiresAt: r.expires_at };
  } catch {
    return null;
  }
}
