"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import type { VerifyPasskeyAuthenticationParams, VerifyPasskeyRegistrationParams } from "@supabase/supabase-js";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { signInHome } from "@/lib/companion";
import { SHARED_DEVICE_COOKIE } from "@/lib/shared-device";
import { passkeyRefusalMessage } from "@/lib/passkeys";
import { passkeyRefusal, passkeysAvailable } from "@/server/passkeys";
import { EARLY_ACCESS_REQUIRED, hasSiteAccess } from "@/server/site-access-request";
import { createClient } from "@/server/supabase/server";

// Face or fingerprint sign-in (passkeys, master plan DS1). The browser runs only the WebAuthn ceremony; the challenge,
// the check of the signed answer and the session all happen between this server and Supabase Auth, so the session
// cookie stays httpOnly. Nothing here logs a credential or a session.

const OFF = "Face or fingerprint sign-in is not turned on for this site. Sign in with your username and password.";
const challengeId = z.string().min(8).max(200);
const credential = z.record(z.string(), z.unknown()).refine((c) => JSON.stringify(c).length <= 20_000, "Too large.");

type Options = { challengeId: string; options: Record<string, unknown> };

/** Status and code of an Auth or WebAuthn error, for logs and messages (never the error's text). */
function codes(error: unknown): { status?: number; code?: string } {
  const e = (error ?? {}) as { status?: unknown; code?: unknown };
  return { status: typeof e.status === "number" ? e.status : undefined, code: typeof e.code === "string" ? e.code : undefined };
}

function authFail(raw: unknown, fallback: string) {
  const error = codes(raw);
  if (error?.code === "webauthn_challenge_expired") return fail("That took too long. Try again.");
  if (error?.code === "user_banned") return fail("This sign-in is turned off. Contact your company's administrator.");
  if (error?.status === 429) return fail("Too many attempts. Wait a minute and try again.");
  return fail(fallback);
}

/** Step 1 of signing in: a challenge from Supabase Auth (no account named; the phone offers its own passkey). */
export async function passkeySignInStart(): Promise<ActionResult<Options>> {
  if (!(await hasSiteAccess())) return fail(EARLY_ACCESS_REQUIRED);
  if (!(await passkeysAvailable())) return fail(OFF);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.passkey.startAuthentication();
  if (error || !data) {
    console.warn("Passkey sign-in start refused", codes(error));
    return authFail(error, "Face or fingerprint sign-in is not available right now. Sign in with your password.");
  }
  return ok({ challengeId: data.challenge_id, options: data.options as unknown as Record<string, unknown> });
}

/** Step 2: Supabase Auth checks the phone's signed answer and the session is written on this response. */
export async function passkeySignInFinish(id: string, answer: Record<string, unknown>): Promise<ActionResult<{ next: string }>> {
  if (!(await hasSiteAccess())) return fail(EARLY_ACCESS_REQUIRED);
  const parsed = z.object({ id: challengeId, answer: credential }).safeParse({ id, answer });
  if (!parsed.success) return fail("Face or fingerprint sign-in did not work. Try again.");
  const supabase = await createClient();
  const { data, error } = await supabase.auth.passkey.verifyAuthentication({
    challengeId: parsed.data.id,
    credential: parsed.data.answer as unknown as VerifyPasskeyAuthenticationParams["credential"],
  });
  if (error || !data?.session) {
    console.warn("Passkey sign-in refused", codes(error));
    return authFail(error, "Face or fingerprint was not accepted. Try again, or sign in with your password.");
  }
  // Only driver sign-ins without money permissions sign in this way (SEC4), never the Taviron team: a passkey set up
  // before the person's role changed ends here, and they sign in with their password (and two-step verification).
  const refused = await passkeyRefusal(supabase);
  if (refused) {
    console.warn("Passkey sign-in refused by the sign-in rule", { reason: refused });
    await supabase.auth.signOut({ scope: "local" });
    return fail(passkeyRefusalMessage(refused));
  }
  // A phone that signs in with its owner's face or fingerprint is that person's own device: stay signed in.
  (await cookies()).delete(SHARED_DEVICE_COOKIE);
  const access = await supabase.rpc("my_access");
  const home = signInHome(((access.data as { permissions?: string[] } | null)?.permissions) ?? []);
  return ok({ next: home ?? "/command-center" });
}

async function signedIn() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ? supabase : null;
}

/** Setting it up on this phone, step 1 (the signed-in person only, for their own sign-in). */
export async function passkeyRegisterStart(): Promise<ActionResult<Options>> {
  const supabase = await signedIn();
  if (!supabase) return fail("Your session ended. Sign in again.");
  if (!(await passkeysAvailable())) return fail(OFF);
  // Only active driver sign-ins without money permissions (SEC4); never the Taviron team, whose two-step rule stays the
  // authenticator app, and never a demo sign-in (docs/ACCOUNT_PROVISIONING.md §7). The database decides; fails closed.
  const refused = await passkeyRefusal(supabase);
  if (refused) return fail(passkeyRefusalMessage(refused));
  const { data, error } = await supabase.auth.passkey.startRegistration();
  if (error || !data) {
    console.warn("Passkey setup start refused", codes(error));
    return authFail(error, "Face or fingerprint sign-in could not be set up right now. Try again later.");
  }
  return ok({ challengeId: data.challenge_id, options: data.options as unknown as Record<string, unknown> });
}

/** Step 2: Supabase Auth stores the phone's new passkey; the company's history records it (no secret). */
export async function passkeyRegisterFinish(id: string, answer: Record<string, unknown>): Promise<ActionResult> {
  const supabase = await signedIn();
  if (!supabase) return fail("Your session ended. Sign in again.");
  const parsed = z.object({ id: challengeId, answer: credential }).safeParse({ id, answer });
  if (!parsed.success) return fail("Face or fingerprint sign-in could not be set up. Try again.");
  // Checked again: the person's role may have changed since step 1.
  const refused = await passkeyRefusal(supabase);
  if (refused) return fail(passkeyRefusalMessage(refused));
  const { error } = await supabase.auth.passkey.verifyRegistration({ challengeId: parsed.data.id, credential: parsed.data.answer as unknown as VerifyPasskeyRegistrationParams["credential"] });
  if (error) {
    console.warn("Passkey setup refused", codes(error));
    return authFail(error, "Face or fingerprint sign-in could not be set up. Try again.");
  }
  await supabase.rpc("my_passkey_added");
  return ok(undefined, "Done. Next time, tap \"Sign in with face or fingerprint\".");
}
