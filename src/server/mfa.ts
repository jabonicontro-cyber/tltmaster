import "server-only";
import { cache } from "react";
import { mfaReason, recoveryCodesPending } from "@/lib/mfa-policy";
import { createClient } from "@/server/supabase/server";

// Two-step verification (MFA) state for the signed-in person (20261120000900). The assurance level comes from the
// verified session token (getClaims), never from the browser. Before the migration is installed nothing is required
// (the policy function does not exist), so a deployment ahead of the database update locks nobody out.

export type MfaPolicy = {
  platform: boolean;
  companies: string[];
  current_company: boolean;
  /** Holds a money permission in a real company: always required, whatever the company setting (20261120018000). */
  money?: boolean;
  /** The reason shown to the person (20261120018000 and later). */
  reason?: string | null;
  recovery_codes: number;
  /** Unused recovery codes confirmed as saved after the newest set was made (20261120018000 and later). */
  recovery_ready?: boolean;
  recent_failures: number;
  aal2: boolean;
  /** A verified authenticator exists (from auth.mfa_factors; 20261120001100 and later). */
  enrolled?: boolean;
};

export type MfaState = {
  installed: boolean;
  aal: "aal1" | "aal2";
  /** Must have a verified second factor in this session to continue (policy). */
  required: boolean;
  /** The person set up an authenticator, so every session must verify it (Auth's next level is aal2). */
  enrolled: boolean;
  reason: string | null;
  /**
   * Money access (owner 2026-11-10): verified, but recovery codes are not yet created and confirmed as saved. Nothing
   * opens until they are (pages and actions, through mfaBlock below).
   */
  recoveryPending: boolean;
  policy: MfaPolicy | null;
};

export const mfaState = cache(async (): Promise<MfaState> => {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const aal = claims?.claims?.aal === "aal2" ? "aal2" : "aal1";
  const { data, error } = await supabase.rpc("mfa_policy");
  if (error && ["PGRST202", "42883"].includes(error.code ?? "")) {
    // Before 20261120000900: nothing is required. The session's own factor list still decides a self-enrolled person.
    const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    return { installed: false, aal, required: false, enrolled: level?.nextLevel === "aal2", reason: null, recoveryPending: false, policy: null };
  }
  if (error || !data) {
    // Any other failure: fail closed (ask for the second factor) rather than skip a policy we could not read.
    console.error("MFA policy check failed", { code: error?.code });
    return { installed: true, aal, required: true, enrolled: false, reason: "Two-step verification could not be checked right now.", recoveryPending: false, policy: null };
  }
  const policy = data as MfaPolicy;
  // The database's factor list when available (20261120001100); the browser's session copy is not trusted for it.
  const enrolled = typeof policy.enrolled === "boolean" ? policy.enrolled : (await supabase.auth.mfa.getAuthenticatorAssuranceLevel()).data?.nextLevel === "aal2";
  // The database's own reason when it gives one (20261120018000); the same order before that.
  const reason = (typeof policy.reason === "string" && policy.reason) || mfaReason(policy);
  return { installed: true, aal, required: Boolean(reason), enrolled, reason, recoveryPending: recoveryCodesPending(policy, aal), policy };
});

/**
 * What stops this page or action, if anything: "verify" when the person must verify (or set up) a second factor (a
 * policy requires it, or they set up an authenticator themselves, otherwise enrolling would protect nothing);
 * "recovery" when money access still needs its recovery codes created and confirmed as saved (owner 2026-11-10).
 */
export async function mfaBlock(): Promise<"verify" | "recovery" | null> {
  const s = await mfaState();
  if ((s.required || s.enrolled) && s.aal !== "aal2") return "verify";
  return s.recoveryPending ? "recovery" : null;
}

/** True when two-step verification stops this page or action (see mfaBlock). */
export async function mfaBlocks(): Promise<boolean> {
  return (await mfaBlock()) !== null;
}

export class MfaRequiredError extends Error {
  constructor(kind: "verify" | "recovery" = "verify") {
    super(kind === "recovery"
      ? "Save your recovery codes first: open Two-step verification, create them and confirm you saved them."
      : "Two-step verification is required. Verify with your authenticator app and try again.");
    this.name = "MfaRequiredError";
  }
}
