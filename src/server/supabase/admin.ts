import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/server/env";

/** True when the service-role key is configured (user invitations). */
export function adminAvailable(): boolean {
  return Boolean(env().SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Service-role client. Bypasses RLS — use only for narrowly scoped admin
 * operations after the caller's permission has been checked.
 */
export function createAdminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = env();
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
