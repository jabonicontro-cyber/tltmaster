"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { looksLikeAccessCode } from "@/lib/early-access";
import { safeNextPath } from "@/lib/safe-redirect";
import { signSiteAccess } from "@/lib/site-access-token";
import { accessCodeHash, clientIp, rateKey } from "@/server/early-access";
import { accessCookieName, siteGate } from "@/server/site-access";
import { requestIsHttps } from "@/server/site-access-request";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";

const input = z.object({ code: z.string().trim().min(1, "Enter your access code.").max(64, "This access code is not valid."), next: z.string().optional() });

/** After the gate comes the normal sign-in (or sign-up / reset), carrying the page the visitor wanted. */
function signInFirst(next: string): string {
  if (["/login", "/signup", "/forgot-password"].some((p) => next === p || next.startsWith(`${p}?`))) return next;
  return `/login?next=${encodeURIComponent(next)}`;
}

/** Same message for a wrong or unknown code: nothing reveals how close a guess was. */
const MESSAGES: Record<string, string> = {
  unknown: "This access code is not valid. Check it and try again.",
  expired: "This access code has expired. Ask the person who invited you for a new one.",
  revoked: "This access code is no longer active. Ask the person who invited you for a new one.",
  used_up: "This access code has reached its limit of devices. Ask the person who invited you for a new one.",
  rate_limited: "Too many attempts from this network. Wait 15 minutes and try again.",
};

/**
 * Check an early-access code on the server and admit this browser: the database
 * rate-limits attempts, checks the code (hash only) and records a grant; the
 * browser gets a signed, HttpOnly cookie for the grant. Then on to sign-in (or
 * the page the visitor asked for). Nothing here creates an account, a company,
 * a membership or a permission. The code itself is never stored or logged.
 */
export async function enterEarlyAccess(formData: FormData): Promise<ActionResult> {
  const gate = siteGate();
  const parsed = input.safeParse(Object.fromEntries(formData));
  const next = signInFirst(safeNextPath(parsed.success ? parsed.data.next : undefined, "/login"));
  if (!gate.enabled) redirect(next);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter your access code.", fieldErrors: { code: parsed.error.issues[0]?.message ?? "" } };
  if (!gate.secret || !adminAvailable()) return { ok: false, error: "Early access is not available on this server yet. Please try again later." };

  // A malformed code still counts as a failed attempt for rate limiting.
  const codeHash = looksLikeAccessCode(parsed.data.code) ? accessCodeHash(parsed.data.code) : "0".repeat(64);
  const { data, error } = await createAdminClient().rpc("site_access_redeem", { p_code_hash: codeHash, p_ip_hash: rateKey(await clientIp()), p_days: gate.days });
  if (error || !data) {
    console.error("Early-access check failed", error?.code);
    return { ok: false, error: "Early access is temporarily unavailable. Please try again in a minute." };
  }
  const r = data as { ok: boolean; reason?: string; grant_id?: string; expires_at?: string };
  if (!r.ok || !r.grant_id || !r.expires_at) {
    const msg = MESSAGES[r.reason ?? "unknown"] ?? MESSAGES.unknown;
    return { ok: false, error: msg, fieldErrors: r.reason === "rate_limited" ? {} : { code: msg } };
  }

  const now = Math.floor(Date.now() / 1000);
  const expires = Math.floor(new Date(r.expires_at).getTime() / 1000);
  const secure = await requestIsHttps();
  (await cookies()).set(accessCookieName(secure), signSiteAccess({ g: r.grant_id, x: expires, c: now }, gate.secret), {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(expires - now, 0),
  });
  redirect(next);
}
