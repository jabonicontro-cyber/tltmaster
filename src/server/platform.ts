import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { MfaRequiredError, mfaBlocks } from "@/server/mfa";

/**
 * Platform owner (the Taviron team) — separate from every company role.
 * Granted only by an operator (scripts/platform-admin.mjs); checked here for
 * pages and actions, and again inside every platform_* database function.
 */
export const isPlatformAdmin = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return false;
  const { data, error } = await supabase.rpc("platform_whoami");
  return !error && data === true;
});

/** For platform pages: sign-in first; anyone else gets "not found" (the area is not revealed). */
export async function requirePlatformAdmin(): Promise<{ userId: string; email: string }> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login?next=/admin");
  if (!(await isPlatformAdmin())) notFound();
  // Mandatory two-step verification for the platform team (also enforced in every platform_* database function).
  if (await mfaBlocks()) redirect("/mfa?next=/admin");
  return { userId: String(claims.claims.sub), email: String(claims.claims.email ?? "") };
}

export class PlatformAccessError extends Error {
  constructor() {
    super("Not available.");
    this.name = "PlatformAccessError";
  }
}

/** For platform server actions: throws for anyone who is not a platform admin. */
export async function assertPlatformAdmin(): Promise<void> {
  if (!(await isPlatformAdmin())) throw new PlatformAccessError();
  if (await mfaBlocks()) throw new MfaRequiredError();
}
