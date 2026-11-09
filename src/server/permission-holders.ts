import "server-only";
import { ROLES, type AppRole } from "@/lib/permissions";
import { createClient } from "@/server/supabase/server";

/**
 * The roles of the person's own company that hold a permission (role_permissions, readable by every member; RLS keeps
 * it to the company), in the usual role order. Null when it could not be read: messages then name no role.
 */
export async function rolesWith(permission: string): Promise<AppRole[] | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("role_permissions").select("role").eq("permission", permission);
    if (error || !data) return null;
    const held = new Set((data as Array<{ role: string }>).map((r) => r.role));
    return ROLES.filter((r) => held.has(r));
  } catch {
    return null;
  }
}
