import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/server/env";

/**
 * Re-authentication for high-impact platform actions (Go Live Now): the signed-in person enters their password again.
 * A separate, non-persisting client signs in (which records auth.users.last_sign_in_at — the database function checks
 * that it is recent) and then ends only that extra session; the person's browser session is not touched. The password
 * is never logged or stored.
 */
export async function confirmPassword(email: string, password: string): Promise<boolean> {
  if (!email || !password || password.length > 200) return false;
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();
  const client = createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  await client.auth.signOut({ scope: "local" });
  return true;
}

/**
 * Password and authenticator code again (inviting Taviron staff, raising someone to Admin). Same separate,
 * non-persisting client: it signs in with the password, then verifies the 6-digit code against the person's
 * authenticator app, which the database sees as a fresh verified challenge (private.require_fresh_reauth). Neither
 * value is logged or stored.
 */
export async function confirmPasswordAndCode(email: string, password: string, code: string): Promise<"ok" | "password" | "code"> {
  if (!email || !password || password.length > 200) return "password";
  if (!/^\d{6}$/.test(code)) return "code";
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();
  const client = createClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) return "password";
  try {
    const { data: factors } = await client.auth.mfa.listFactors();
    const factor = (factors?.totp ?? []).find((f) => f.status === "verified");
    if (!factor) return "code";
    const verified = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    return verified.error ? "code" : "ok";
  } finally {
    await client.auth.signOut({ scope: "local" });
  }
}
