
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

/** One person's two-step state from public.company_mfa_status() (20261120019900): nothing else is ever returned. */
export type MemberMfaRow = { user_id: string; money: boolean; set_up: boolean; recovery_ready: boolean | null };

export type MemberMfaStatus = {
  id: string;
  name: string;
  role: string | null;
  /** Why they must use it, in plain words; null when nothing requires it. */
  reason: "Money access" | "Company rule" | null;
  /** Counted as done: set up, with recovery codes saved when money access needs them. */
  done: boolean;
  label: string;
  detail: string | null;
  tone: "green" | "amber" | "gray";
};

/**
 * Settings → Security (SEC4b, owner 2026-11-12): each active person's two-step state in plain words. The database
 * decides money access and set-up (company_mfa_status); the company rule is the company's own setting. In a demo
 * company money access never counts, so a person whose role holds a money permission is "Not needed in a demo".
 */
export function memberMfaStatuses(
  people: Array<{ id: string; name: string; role: string | null; active: boolean }>,
  rows: MemberMfaRow[],
  opts: { companyRule: boolean; demo: boolean; moneyRoles: string[] },
): MemberMfaStatus[] {
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  return people
    .filter((p) => p.active && byId.has(p.id))
    .map((p): MemberMfaStatus => {
      const r = byId.get(p.id)!;
      const reason: MemberMfaStatus["reason"] = r.money ? "Money access" : opts.companyRule ? "Company rule" : null;
      const base = { id: p.id, name: p.name, role: p.role, reason };
      if (reason) {
        if (!r.set_up) return { ...base, done: false, label: "Not set up yet", detail: "Will be asked at next sign-in", tone: "amber" as const };
        if (r.money && r.recovery_ready === false) {
          return { ...base, done: false, label: "Recovery codes not saved", detail: "Will be asked to save them the next time they open Taviron", tone: "amber" as const };
        }
        return { ...base, done: true, label: "Set up", detail: null, tone: "green" as const };
      }
      if (r.set_up) return { ...base, done: true, label: "Set up", detail: "Not required here", tone: "green" as const };
      if (opts.demo && p.role && opts.moneyRoles.includes(p.role)) {
        return { ...base, done: false, label: "Not needed in a demo", detail: "In a real company this role always needs it", tone: "gray" as const };
      }
      return { ...base, done: false, label: "Not required", detail: null, tone: "gray" as const };
    })
    .sort((a, b) => Number(Boolean(b.reason)) - Number(Boolean(a.reason)) || Number(a.done) - Number(b.done) || a.name.localeCompare(b.name));
}

/** "2 of 3 people who must use two-step have set it up"; null when nobody must. */
export function mfaSetUpSummary(statuses: MemberMfaStatus[]): string | null {
  const must = statuses.filter((s) => s.reason);
  if (must.length === 0) return null;
  const done = must.filter((s) => s.done).length;
  return must.length === 1
    ? `${done} of 1 person who must use two-step has set it up`
    : `${done} of ${must.length} people who must use two-step have set it up`;
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
