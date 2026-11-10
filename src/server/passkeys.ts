import "server-only";
import type { PasskeyRefusal } from "@/lib/passkeys";
import { env } from "@/server/env";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

// Face or fingerprint sign-in (passkeys, master plan DS1) through Supabase Auth's passkey API. Whether the auth server
// offers passkeys is asked from the server itself: a passkey sign-in starts with a challenge request, so the same
// request answers whether it works (an auth server without passkeys answers 404, one with them turned off refuses).
// The answer is kept for 10 minutes per server instance, so the sign-in page does not ask on every visit. Without
// passkeys every button for them stays hidden and passwords and QR codes work as before.

const CACHE_MS = 10 * 60 * 1000;
let cached: { at: number; available: boolean } | null = null;

export async function passkeysAvailable(): Promise<boolean> {
  if ((process.env.PASSKEYS ?? "").trim().toLowerCase() === "off") return false;
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.available;
  let available = false;
  try {
    const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();
    const res = await fetch(`${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/passkeys/authentication/options`, {
      method: "POST",
      headers: { apikey: NEXT_PUBLIC_SUPABASE_ANON_KEY, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    const body = res.ok ? ((await res.json().catch(() => null)) as { challenge_id?: string } | null) : null;
    available = Boolean(body?.challenge_id);
  } catch {
    available = false;
  }
  cached = { at: now, available };
  return available;
}

/**
 * Why the signed-in person may not set up or use face or fingerprint sign-in, or null when they may: only active
 * driver sign-ins without money permissions, never the Taviron team or a demo (public.my_passkey_refusal, migration
 * 20261120017100). Fails closed: when the database cannot answer (update not installed, error), it is refused.
 */
export async function passkeyRefusal(client?: Awaited<ReturnType<typeof createClient>>): Promise<PasskeyRefusal | null> {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase.rpc("my_passkey_refusal");
  if (error) return "unavailable";
  return data ? (String(data) as PasskeyRefusal) : null;
}

export interface PasskeySummary {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A person's passkeys, read with the Auth admin API (call only after the database allowed the caller). */
export async function listPasskeysFor(userId: string): Promise<PasskeySummary[] | null> {
  if (!adminAvailable()) return null;
  const { data, error } = await createAdminClient().auth.admin.passkey.listPasskeys({ userId });
  if (error || !data) return null;
  return data.map((p) => ({ id: p.id, name: p.friendly_name ?? null, createdAt: p.created_at, lastUsedAt: p.last_used_at ?? null }));
}

/**
 * For the office's driver page: null when passkeys are not offered on this site (nothing is shown); otherwise how many
 * phones the person set up (count null when it could not be read). The database first checks that the caller may
 * manage this sign-in (signin_passkey_check); only then is the Auth admin API asked.
 */
export async function managedPasskeys(userId: string): Promise<{ count: number | null } | null> {
  if (!(await passkeysAvailable())) return null;
  const check = await (await createClient()).rpc("signin_passkey_check", { p_user: userId });
  if (check.error) return null;
  const list = await listPasskeysFor(userId);
  return { count: list ? list.length : null };
}

/** Remove every passkey of a person (lost or new phone). Returns how many were removed, or null when it failed. */
export async function removePasskeysFor(userId: string): Promise<number | null> {
  const list = await listPasskeysFor(userId);
  if (list === null) return null;
  const admin = createAdminClient();
  let removed = 0;
  for (const p of list) {
    const { error } = await admin.auth.admin.passkey.deletePasskey({ userId, passkeyId: p.id });
    if (error) return removed > 0 ? removed : null;
    removed++;
  }
  return removed;
}
