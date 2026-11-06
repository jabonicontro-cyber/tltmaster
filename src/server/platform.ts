import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { MfaRequiredError, mfaBlocks } from "@/server/mfa";

/**
 * The Taviron team — separate from every company role. Two levels (SA1, 20261120008900): Admin (the whole console)
 * and Support (the support desk at /staff only). Invited from the console by an Admin (or, as the operator's fallback,
 * scripts/platform-admin.mjs); checked here for pages and actions, and again inside every platform_* database function.
 */
export type StaffLevel = "admin" | "support";

/** The signed-in person's staff level, or null. Before 20261120008900 is installed: admin when platform_whoami says so. */
export const platformStaffLevel = cache(async (): Promise<StaffLevel | null> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return null;
  const { data, error } = await supabase.rpc("platform_staff_whoami");
  if (!error) return data === "admin" || data === "support" ? data : null;
  return (await isPlatformAdmin()) ? "admin" : null;
});
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
  if (!(await isPlatformAdmin())) {
    // Support staff have the support desk only.
    if ((await platformStaffLevel()) === "support") redirect("/staff");
    notFound();
  }
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

/** For the support desk (/staff): either staff level, two-step verified. Anyone else gets "not found". */
export async function requirePlatformStaff(): Promise<{ userId: string; email: string; level: StaffLevel }> {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login?next=/staff");
  const level = await platformStaffLevel();
  if (!level) notFound();
  if (await mfaBlocks()) redirect("/mfa?next=/staff");
  return { userId: String(claims.claims.sub), email: String(claims.claims.email ?? ""), level };
}

/** For support-desk server actions: either staff level. */
export async function assertPlatformStaff(): Promise<StaffLevel> {
  const level = await platformStaffLevel();
  if (!level) throw new PlatformAccessError();
  if (await mfaBlocks()) throw new MfaRequiredError();
  return level;
}
