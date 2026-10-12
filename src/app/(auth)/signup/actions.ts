"use server";

import { z } from "zod";
import { isUsernameEmail } from "@/lib/usernames";
import type { ActionResult } from "@/lib/action-result";
import { ACCESS_CODE_ERRORS, looksLikeAccessCode } from "@/lib/early-access";
import { accessCodeHash, clientIp, rateKey } from "@/server/early-access";
import { env } from "@/server/env";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";
import { EARLY_ACCESS_REQUIRED, hasSiteAccess } from "@/server/site-access-request";

const signupSchema = z
  .object({
    accessCode: z.string().trim().min(1, "Enter your access code."),
    fullName: z.string().trim().min(1, "Enter your name.").max(120),
    companyName: z.string().trim().min(2, "Enter the company name.").max(120),
    email: z.email("Enter a valid email address.").refine((v) => !isUsernameEmail(v), "This address cannot be used."),
    password: z.string().min(10, "Use at least 10 characters.").max(128),
    confirm: z.string(),
    /** Made when the form opens: a repeated submit is recognised, not processed twice. */
    requestKey: z.uuid(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match.", path: ["confirm"] });

const CHECK_EMAIL = "Check your email: we sent a link to confirm your address. After confirming, sign in to create your company.";
const EXISTS = "An account with this email already exists. Sign in, then choose “Create a company” and enter your access code.";

/**
 * Early-access sign-up. Order: rate limits and the code (server, service role)
 * → account created through the Auth admin API (unconfirmed) → one use of the
 * code reserved for that account → Supabase Auth sends the verification email.
 * Public sign-up stays disabled in Supabase Auth, so this is the only way in.
 */
export async function signUpWithAccessCode(formData: FormData): Promise<ActionResult> {
  if (!(await hasSiteAccess())) return { ok: false, error: EARLY_ACCESS_REQUIRED };
  const parsed = signupSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) fieldErrors[String(i.path[0])] ??= i.message;
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form.", fieldErrors };
  }
  const f = parsed.data;
  if (!adminAvailable()) return { ok: false, error: "Sign-up is not available on this server yet." };
  const admin = createAdminClient();
  const email = f.email.trim().toLowerCase();

  // A repeated submit of this same form (double click, retry after a lost response).
  const earlier = await admin.rpc("early_access_request", { p_request_key: f.requestKey });
  const prior = (earlier.data ?? {}) as { user_id?: string };
  if (prior.user_id) {
    const { data: profile } = await admin.from("profiles").select("email").eq("id", prior.user_id).maybeSingle();
    if (profile?.email?.toLowerCase() !== email) return { ok: false, error: ACCESS_CODE_ERRORS.conflict };
    await sendVerification(email);
    return { ok: true, data: undefined, message: CHECK_EMAIL };
  }

  // 1. Rate limits and the code. A malformed code still counts as a failed attempt.
  const codeHash = looksLikeAccessCode(f.accessCode) ? accessCodeHash(f.accessCode) : "0".repeat(64);
  const check = await admin.rpc("early_access_check", { p_code_hash: codeHash, p_ip_hash: rateKey(await clientIp()), p_email_hash: rateKey(email) });
  if (check.error) {
    console.error("Access code check failed", check.error.message);
    return { ok: false, error: "Sign-up is temporarily unavailable. Try again later." };
  }
  const result = check.data as { ok: boolean; reason: string };
  if (!result.ok) {
    const msg = ACCESS_CODE_ERRORS[result.reason] ?? ACCESS_CODE_ERRORS.unknown;
    return { ok: false, error: msg, fieldErrors: result.reason === "rate_limited" ? {} : { accessCode: msg } };
  }

  // 2. The account, unconfirmed. An existing address is sent to sign in instead
  //    (the code is never attached to an account the requester does not control).
  const created = await admin.auth.admin.createUser({ email, password: f.password, email_confirm: false, user_metadata: { full_name: f.fullName } });
  const userId = created.data.user?.id;
  if (created.error || !userId) {
    if (/already/i.test(created.error?.message ?? "")) return { ok: false, error: EXISTS };
    console.error("Sign-up user creation failed", created.error?.message);
    return { ok: false, error: "The account could not be created. Try again later." };
  }

  // 3. Reserve the code for this account; undo the account if that fails (e.g. the last use was just taken).
  const reserve = await admin.rpc("early_access_reserve", { p_code_hash: codeHash, p_user_id: userId, p_company_name: f.companyName, p_request_key: f.requestKey });
  const reserved = reserve.data as { ok: boolean; reason?: string } | null;
  if (reserve.error || !reserved?.ok) {
    await admin.auth.admin.deleteUser(userId);
    return { ok: false, error: ACCESS_CODE_ERRORS[reserved?.reason ?? ""] ?? "The account could not be created. Try again." };
  }

  // 4. Verification email from Supabase Auth (its templates and SMTP settings).
  await sendVerification(email);
  return { ok: true, data: undefined, message: CHECK_EMAIL };
}

async function sendVerification(email: string) {
  const supabase = await createClient();
  const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${env().APP_BASE_URL}/auth/confirm?next=/onboarding` } });
  if (error) console.error("Verification email failed", { status: error.status, code: error.code });
}
