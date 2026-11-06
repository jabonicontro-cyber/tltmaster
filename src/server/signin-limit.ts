import "server-only";
import { createHash } from "node:crypto";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";

// Failed password attempts per sign-in (security review 2026-11-06, M3; migration 20261120009000). Sign-ins through the
// app reach the auth service from the server's address, so its per-address limit does not see who is guessing; this
// counts failures per login instead (8 in 15 minutes, then 15 minutes refused). Only a hash of the login is stored.
// Before the database update is installed, or without the service key, nothing is limited here (Supabase's own limits
// still apply).

export const SIGNIN_LIMIT_MESSAGE = "Too many wrong passwords for this sign-in. Wait 15 minutes and try again, or reset the password.";

export function loginHash(login: string): string {
  return createHash("sha256").update(login.trim().toLowerCase()).digest("hex");
}

export async function signInAllowed(login: string): Promise<boolean> {
  if (!adminAvailable()) return true;
  const { data, error } = await createAdminClient().rpc("signin_allowed", { p_login_hash: loginHash(login) });
  return error ? true : data !== false;
}

export async function recordSignInFailure(login: string): Promise<void> {
  if (!adminAvailable()) return;
  await createAdminClient().rpc("signin_failed", { p_login_hash: loginHash(login) });
}
