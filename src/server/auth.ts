import "server-only";
import { displayLogin } from "@/lib/usernames";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { can, type Access, type AppRole, type Permission } from "@/lib/permissions";
import { PREVIEW_COOKIE, applyPreview, parsePreviewRole } from "@/lib/platform/preview";
import { isPlatformAdmin } from "@/server/platform";
import { myPortals } from "@/server/portal";
import { MfaRequiredError, mfaBlocks } from "@/server/mfa";

/** The signed-in user's access, loaded once per request from the database. */
export const getAccess = cache(async (): Promise<Access | null> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return null;

  const { data, error } = await supabase.rpc("my_access");
  if (error || !data) return null;

  const row = data as {
    user_id: string;
    email: string;
    full_name: string;
    role: AppRole | null;
    active: boolean;
    permissions: Permission[];
    company_id: string | null;
    company_name: string | null;
  };
  const access: Access = {
    userId: row.user_id,
    companyId: row.company_id,
    companyName: row.company_name,
    email: displayLogin(row.email), // a username for username accounts (display only)
    fullName: row.full_name,
    role: row.role,
    active: row.active,
    permissions: row.permissions ?? [],
    isDemo: false,
    preview: null,
  };
  if (!row.company_id) return access;

  // Demo company? (A missing column — database not yet migrated — means no.)
  const { data: company } = await supabase.from("companies").select("is_demo").eq("id", row.company_id).maybeSingle();
  access.isDemo = Boolean((company as { is_demo?: boolean } | null)?.is_demo);
  if (!access.isDemo) return access;

  // Role preview: only in a demo company, and only ever narrowing.
  const preview = parsePreviewRole((await cookies()).get(PREVIEW_COOKIE)?.value);
  if (!preview) return access;
  const { data: perms } = await supabase.from("role_permissions").select("role, permission");
  return applyPreview(access, preview, (perms as Array<{ role: string; permission: string }> | null) ?? []);
});

/**
 * For a person's own account only (profile, photo): signed in is enough — a platform team member without a company
 * can edit their own profile too. Nothing here can reach company data; the database limits it to the caller's row.
 */
export async function requireSignedIn(): Promise<Access> {
  const access = await getAccess();
  if (!access) redirect("/login");
  return access;
}

/** For pages: redirect to sign-in when signed out, to the no-access page when the account has no role. */
export async function requireAccess(): Promise<Access> {
  const access = await getAccess();
  if (!access) redirect("/login");
  if (!access.active || !access.role || !access.companyId) {
    // A platform team member without a company of their own starts at the launchpad.
    if (await isPlatformAdmin()) redirect("/admin");
    // A trucking company's customer (portal account, not a membership) goes to their portal (B66).
    if (!access.companyId && (await myPortals()).length) redirect("/portal");
    redirect("/no-access");
  }
  // Two-step verification required by the person's role (platform) or company policy (20261120000900).
  if (await mfaBlocks()) redirect("/mfa");
  return access;
}

/** For pages: render the "not permitted" screen when the permission is missing. */
export async function requirePagePermission(permission: Permission): Promise<Access> {
  const access = await requireAccess();
  if (!can(access, permission)) redirect(`/no-access?missing=${encodeURIComponent(permission)}`);
  return access;
}

export class PermissionError extends Error {
  constructor(permission: Permission) {
    super(`You do not have permission to perform this action (${permission}).`);
    this.name = "PermissionError";
  }
}

/** For server actions and route handlers: throws PermissionError. */
export async function assertPermission(permission: Permission): Promise<Access> {
  const access = await getAccess();
  if (!access || !access.active || !access.companyId || !can(access, permission)) {
    throw new PermissionError(permission);
  }
  if (await mfaBlocks()) throw new MfaRequiredError();
  return access;
}
