import type { Permission } from "@/lib/permissions";

// Two-step verification rules shared by the server and the pages (20261120000900, 20261120018000). The database decides
// who must verify (public.mfa_policy, private.current_company_id); this file only words it.

/**
 * The permissions that show or change money (owner decision 2026-11-09, master plan §12 SEC4). Anyone who holds one
 * in a real (non-demo) company always uses two-step verification. The same list as private.money_permissions() in the
 * database (checked by tests/db/money-two-step.test.ts).
 */
export const MONEY_PERMISSIONS = [
  "billing.view",
  "billing.manage",
  "accounting.view",
  "payroll.manage",
  "employees.compensation",
  "pricing.edit",
  "pricing.override",
  "maintenance.costs",
  "audit.view",
  // Company settings set the default sales tax rate; user management can hand any money permission to any account.
  "settings.manage",
  "users.manage",
] as const satisfies readonly Permission[];

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

/** Why two-step verification is required for this person, most specific first; null when nothing requires it. */
export function mfaReason(policy: { platform: boolean; money?: boolean; current_company: boolean }): string | null {
  if (policy.platform) return "Platform administrators must use two-step verification.";
  if (policy.money) return MONEY_MFA_REASON;
  if (policy.current_company) return "Your company requires two-step verification.";
  return null;
}
