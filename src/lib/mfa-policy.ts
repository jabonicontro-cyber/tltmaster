
// Two-step verification rules shared by the server and the pages (20261120000900, 20261120018000). The database decides
// who must verify (public.mfa_policy, private.current_company_id); this file only words it.

// The money list lives in src/lib/permissions.ts (one list for two-step verification and QR sign-in).
export { MONEY_PERMISSIONS } from "@/lib/permissions";
import { isMoneyPermission } from "@/lib/permissions";

export const MONEY_MFA_REASON = "Your access to invoices, payments or pay requires two-step verification.";

/**
 * Money access needs recovery codes too (owner decision 2026-11-10): a verified person with money access is not done
 * until unused codes exist and were confirmed as saved after the newest set was made. Databases before
 * 20261120018000 report no money access, so nothing is pending there.
 */
export function recoveryCodesPending(
  policy: { money?: boolean; recovery_codes: number; recovery_ready?: boolean } | null | undefined,
  aal: "aal1" | "aal2",
): boolean {
  if (!policy?.money || aal !== "aal2") return false;
  return typeof policy.recovery_ready === "boolean" ? !policy.recovery_ready : policy.recovery_codes === 0;
}

/**
 * Who must use two-step verification in this company because of money access (SEC4, 20261120018000): the roles whose
 * permissions here include a money permission (isMoneyPermission, the same list as private.money_permissions()), each
 * with the money permissions it holds, and the active people in that role. Pure: reads the company's role settings and
 * memberships as given; the database decides.
 */
export function moneyRoles<R extends string>(
  grants: Array<{ role: R; permission: string }>,
  people: Array<{ id: string; name: string; role: R | null; active: boolean }>,
): Array<{ role: R; permissions: string[]; people: Array<{ id: string; name: string }> }> {
  const byRole = new Map<R, string[]>();
  for (const g of grants) if (isMoneyPermission(g.permission)) byRole.set(g.role, [...(byRole.get(g.role) ?? []), g.permission]);
  return [...byRole.entries()].map(([role, permissions]) => ({
    role,
    permissions: [...new Set(permissions)].sort(),
    people: people.filter((p) => p.active && p.role === role).map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/** Why two-step verification is required for this person, most specific first; null when nothing requires it. */
export function mfaReason(policy: { platform: boolean; money?: boolean; current_company: boolean }): string | null {
  if (policy.platform) return "Platform administrators must use two-step verification.";
  if (policy.money) return MONEY_MFA_REASON;
  if (policy.current_company) return "Your company requires two-step verification.";
  return null;
}

/** "ABCD EFGH IJKL …": a setup key in groups of four (walkthrough 2026-11-11). */
export function groupKey(secret: string): string {
  return secret.replace(/\s+/g, "").replace(/(.{4})(?=.)/g, "$1 ");
}

/** The recovery codes as a plain text file, one per line, with what they are. */
export function recoveryCodesText(codes: string[]): string {
  return ["Taviron recovery codes", "Each code works once. Keep them somewhere safe, away from your phone.", "", ...codes, ""].join("\n");
}
