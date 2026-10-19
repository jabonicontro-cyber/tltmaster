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
