import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { can, type Access, type AppRole, type Permission } from "@/lib/permissions";

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
  return {
    userId: row.user_id,
    companyId: row.company_id,
    companyName: row.company_name,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    active: row.active,
    permissions: row.permissions ?? [],
  };
});

/** For pages: redirect to sign-in when signed out, to the no-access page when the account has no role. */
export async function requireAccess(): Promise<Access> {
  const access = await getAccess();
  if (!access) redirect("/login");
  if (!access.active || !access.role || !access.companyId) redirect("/no-access");
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
  return access;
}
