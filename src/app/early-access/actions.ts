"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { looksLikeAccessCode } from "@/lib/early-access";
import { safeNextPath } from "@/lib/safe-redirect";
import { SHARED_PASSWORD_MAX_LENGTH, sharedPasswordFingerprint, sharedPasswordMatches } from "@/lib/shared-password";
import { signSiteAccess } from "@/lib/site-access-token";
import { accessCodeHash, clientIp, rateKey } from "@/server/early-access";
import { accessCookieName, sharedPasswordConfig, siteGate } from "@/server/site-access";
import { requestIsHttps } from "@/server/site-access-request";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";

/** One message for every refusal, so nothing reveals how close a guess was or which kind of credential it was. */
const NOT_VALID = "That password isn't valid. Check it and try again, or ask the person who invited you.";
const RATE_LIMITED = "Too many attempts from this network. Wait 15 minutes and try again.";
const UNAVAILABLE = "Early access is temporarily unavailable. Please try again in a minute.";

const input = z.object({
  password: z.string().trim().min(1, "Enter the Early Access password.").max(SHARED_PASSWORD_MAX_LENGTH, NOT_VALID),
  next: z.string().optional(),
});

/** After the gate comes the normal sign-in (or sign-up / reset), carrying the page the visitor wanted. */
function signInFirst(next: string): string {
  if (["/login", "/signup", "/forgot-password"].some((p) => next === p || next.startsWith(`${p}?`))) return next;
  return `/login?next=${encodeURIComponent(next)}`;
}

type Grant = { ok: boolean; reason?: string; grant_id?: string; expires_at?: string };

/**
 * Check the Early Access password on the server and admit this browser.
 *
 * Accepts the shared password (EARLY_ACCESS_PASSWORD, compared in constant
 * time; the database sees only a keyed fingerprint) or a personal site code
 * from scripts/early-access.mjs (the database sees only its hash). Either way
 * the database rate-limits by client address and records a grant for this one
 * device; the browser gets a signed, HttpOnly cookie for that grant, which the
 * proxy re-checks with the database every few minutes, so revoking it ends
 * access. Then on to the normal sign-in. Nothing here creates an account, a
 * company, a membership or a permission. Submitted values are never stored or
 * logged.
 */
export async function enterEarlyAccess(formData: FormData): Promise<ActionResult> {
  const gate = siteGate();
  const parsed = input.safeParse(Object.fromEntries(formData));
  const next = signInFirst(safeNextPath(parsed.success ? parsed.data.next : undefined, "/login"));
  if (!gate.enabled) redirect(next);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? NOT_VALID;
    return { ok: false, error: msg, fieldErrors: { password: msg } };
  }
  if (!gate.secret || !adminAvailable()) return { ok: false, error: UNAVAILABLE };

  const admin = createAdminClient();
  const ip = rateKey(await clientIp());
  const shared = sharedPasswordConfig();
  const value = parsed.data.password;
  const sharedEntry = Boolean(shared.password && sharedPasswordMatches(value, shared.password, gate.secret));
  let result: { data: unknown; error: { code?: string } | null };
  if (sharedEntry && shared.password) {
    result = await admin.rpc("site_access_enter_shared", {
      p_fingerprint: sharedPasswordFingerprint(shared.password, gate.secret),
      p_ip_hash: ip,
      p_days: gate.days,
      p_max_devices: shared.maxDevices,
    });
  } else {
    // Says only whether the setting exists on this deployment (never a value): a variable added in the
    // hosting dashboard reaches only deployments built after it, which otherwise looks like a wrong password.
    if (!shared.password && !looksLikeAccessCode(value)) console.warn("Early access: EARLY_ACCESS_PASSWORD is not set on this deployment (or is shorter than 12 characters).");
    // A personal site code, or a wrong value: either way the attempt is recorded and rate limited.
    const codeHash = looksLikeAccessCode(value) ? accessCodeHash(value) : "0".repeat(64);
    result = await admin.rpc("site_access_redeem", { p_code_hash: codeHash, p_ip_hash: ip, p_days: gate.days });
  }
  if (result.error || !result.data) {
    console.error("Early-access check failed", result.error?.code);
    return { ok: false, error: UNAVAILABLE };
  }
  const r = result.data as Grant;
  if (!r.ok || !r.grant_id || !r.expires_at) {
    if (r.reason === "rate_limited") return { ok: false, error: RATE_LIMITED };
    // The visitor sees the generic message; the owner finds the reason in the server log (no password, no address).
    if (sharedEntry) console.warn("Shared early-access password refused:", r.reason === "used_up" ? "device limit reached" : "password record revoked");
    return { ok: false, error: NOT_VALID, fieldErrors: { password: NOT_VALID } };
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
