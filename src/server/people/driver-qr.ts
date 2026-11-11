import "server-only";
import { can, isMoneyPermission, type Access } from "@/lib/permissions";
import { managedPasskeys } from "@/server/passkeys";
import { createClient } from "@/server/supabase/server";

/**
 * Which "Show sign-in QR code" a person sees for a driver (master plan DS1), the same on the driver's Fleet page and on
 * their People page (walkthrough 2026-11-11):
 *   "demo"       a labelled sample in a demo company (nothing real signs in; docs/DEMO_TENANTS.md §2);
 *   "live"       a real one-time code: an active driver sign-in, users.manage, and the driver role has no money
 *                permission (two-step verification is for money, SEC4; the database refuses it too);
 *   "money"      off because the driver role sees or changes money;
 *   "login_off"  off because the sign-in is turned off;
 *   "not_driver" the login has another role (they sign in with a username or email and password);
 *   null         nothing to show (no users.manage, inactive driver, or no login outside a demo).
 * A Taviron support visit still cannot show a code (the component, the server and the database refuse it).
 */
export type DriverQrMode = "demo" | "live" | "money" | "login_off" | "not_driver";

export async function driverQrAccess(
  access: Pick<Access, "permissions">,
  d: { demo: boolean; driverActive: boolean; userId: string | null; accountRole: string | null; accountActive: boolean | null | undefined },
): Promise<{ mode: DriverQrMode | null; passkeys: { count: number | null } | null }> {
  const canManageSignIns = d.driverActive && can(access, "users.manage");
  if (!canManageSignIns) return { mode: null, passkeys: null };
  if (d.demo) return { mode: "demo", passkeys: null };
  if (!d.userId) return { mode: null, passkeys: null };
  if (d.accountActive === false) return { mode: "login_off", passkeys: null };
  if (d.accountRole !== "driver") return { mode: "not_driver", passkeys: null };
  const supabase = await createClient();
  const perms = (await supabase.from("role_permissions").select("permission").eq("role", "driver")).data ?? [];
  if (perms.some((r) => isMoneyPermission(String((r as { permission: string }).permission)))) return { mode: "money", passkeys: null };
  return { mode: "live", passkeys: await managedPasskeys(d.userId) };
}
