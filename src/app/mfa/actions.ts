"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { safeNextPath } from "@/lib/safe-redirect";
import { confirmPassword } from "@/server/reauth";
import { assertPermission } from "@/server/auth";
import { mfaState } from "@/server/mfa";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

// Two-step verification (20261120000900): Supabase Auth TOTP factors. Codes are checked by Supabase Auth; this file
// only orders the steps, records events and adds recovery codes and limits. Nothing here can raise a session to aal2
// without a valid authenticator code.

const CODE = /^\d{6}$/;
const LOCKED = "Too many wrong codes. Wait 15 minutes and try again, or use a recovery code.";

async function signedIn() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login?next=/mfa");
  return { supabase, userId: String(data.claims.sub), email: String(data.claims.email ?? "") };
}

async function tooManyFailures(): Promise<boolean> {
  const s = await mfaState();
  return (s.policy?.recent_failures ?? 0) >= 5;
}

/** Start setting up an authenticator app: a QR code and the secret for manual entry. Nothing is active yet. */
export async function startEnrollment(): Promise<ActionResult<{ factorId: string; qr: string; secret: string }>> {
  const { supabase } = await signedIn();
  // An earlier unfinished setup is replaced (an unverified factor protects nothing).
  const { data: list } = await supabase.auth.mfa.listFactors();
  for (const f of list?.all ?? []) if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  if ((list?.totp ?? []).length) return fail("An authenticator app is already set up for this account.");
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
  if (error || !data) return fail(error?.status === 422 ? "Two-step verification is not enabled on this server. Ask the platform owner." : "Could not start the setup. Try again.");
  return ok({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
}

/** Check a code from the app: completes setup (new factor) or verifies this session (existing factor). */
export async function verifyCode(formData: FormData): Promise<ActionResult<{ next: string; enrolled: boolean }>> {
  const { supabase } = await signedIn();
  const code = String(formData.get("code") ?? "").replace(/\s/g, "");
  if (!CODE.test(code)) return fail("Enter the 6-digit code from your authenticator app.", { code: "Six digits." });
  if (await tooManyFailures()) return fail(LOCKED);
  const { data: list } = await supabase.auth.mfa.listFactors();
  const requested = String(formData.get("factorId") ?? "");
  const factor = (list?.all ?? []).find((f) => f.factor_type === "totp" && (requested ? f.id === requested : f.status === "verified"));
  if (!factor) return fail("No authenticator app is set up. Start the setup again.");
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
  if (error) {
    await supabase.rpc("mfa_record_event", { p_event: "mfa.challenge_failed" });
    return fail(error.status === 429 ? LOCKED : "That code did not work. Check the time on your phone and enter the newest code.");
  }
  const enrolled = factor.status === "unverified";
  await supabase.rpc("mfa_record_event", { p_event: enrolled ? "mfa.enrolled" : "mfa.verified" });
  // After a new setup the page stays put to show the recovery codes once; the browser navigates on afterwards.
  if (!enrolled) revalidatePath("/", "layout");
  const next = safeNextPath(String(formData.get("next") ?? ""), "/command-center");
  return ok({ next, enrolled });
}

/** New recovery codes (all earlier ones stop working). Needs a verified second factor in this session. */
export async function generateRecoveryCodes(): Promise<ActionResult<{ codes: string[] }>> {
  const { supabase } = await signedIn();
  const { data, error } = await supabase.rpc("mfa_recovery_generate");
  if (error) return fail(error.code === "42501" ? "Verify with your authenticator app first." : "Recovery codes are not available on this server yet.");
  return ok({ codes: data as string[] }, "New recovery codes created. Earlier codes no longer work.");
}

/**
 * Lost the phone: a one-time recovery code (with the password already entered at sign-in) removes the authenticator
 * so a new one can be set up right away. The code is checked and used up by the database; factors are removed with
 * the Auth admin API. A password reset alone never does this.
 */
export async function redeemRecoveryCode(formData: FormData): Promise<ActionResult> {
  const { supabase, userId } = await signedIn();
  const { data, error } = await supabase.rpc("mfa_recovery_redeem", { p_code: String(formData.get("code") ?? "") });
  if (error) return fail(error.code === "54000" ? error.message : "Recovery codes are not available on this server yet.");
  if (data !== true) return fail("That recovery code is not valid or was already used.");
  if (!adminAvailable()) return fail("The code was accepted but the authenticator could not be reset on this server. Contact the platform owner.");
  const admin = createAdminClient();
  const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId });
  for (const f of factors?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId });
  await supabase.rpc("mfa_record_event", { p_event: "mfa.removed" });
  // The current session token still names the removed factor; a fresh one is needed.
  await supabase.auth.refreshSession();
  redirect("/mfa?reset=1");
}

/**
 * Turn two-step verification off for my account: needs this session at aal2 and the password again, and is refused
 * while a policy requires it.
 */
export async function removeAuthenticator(formData: FormData): Promise<ActionResult> {
  const { supabase, email } = await signedIn();
  const state = await mfaState();
  if (state.required) return fail(state.reason ?? "Two-step verification is required for your account.");
  if (state.aal !== "aal2") return fail("Verify with your authenticator app first.");
  if (!(await confirmPassword(email, String(formData.get("password") ?? "")))) return fail("The password is not correct.", { password: "Not correct." });
  const { data: list } = await supabase.auth.mfa.listFactors();
  for (const f of list?.all ?? []) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
    if (error) return fail("Could not remove the authenticator. Try again.");
  }
  await supabase.rpc("mfa_record_event", { p_event: "mfa.removed" });
  await supabase.auth.refreshSession();
  revalidatePath("/profile");
  return ok(undefined, "Two-step verification is off for your account.");
}

/** Company policy: everyone in this company must use two-step verification (settings.manage; checked again in the database). */
export async function setCompanyMfaPolicy(formData: FormData): Promise<ActionResult> {
  await assertPermission("settings.manage");
  const { supabase } = await signedIn();
  const { error } = await supabase.rpc("set_company_mfa_policy", { p_required: formData.get("required") === "on" });
  if (error) return fail(error.code === "42501" ? error.message : "Could not save the policy.");
  revalidatePath("/settings");
  return ok(undefined, "Saved.");
}
