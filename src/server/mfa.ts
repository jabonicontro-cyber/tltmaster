import "server-only";
import { cache } from "react";
import { createClient } from "@/server/supabase/server";

// Two-step verification (MFA) state for the signed-in person (20261120000900). The assurance level comes from the
// verified session token (getClaims), never from the browser. Before the migration is installed nothing is required
// (the policy function does not exist), so a deployment ahead of the database update locks nobody out.

export type MfaPolicy = {
  platform: boolean;
  companies: string[];
  current_company: boolean;
  recovery_codes: number;
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
    return { installed: false, aal, required: false, enrolled: level?.nextLevel === "aal2", reason: null, policy: null };
  }
  if (error || !data) {
    // Any other failure: fail closed (ask for the second factor) rather than skip a policy we could not read.
    console.error("MFA policy check failed", { code: error?.code });
    return { installed: true, aal, required: true, enrolled: false, reason: "Two-step verification could not be checked right now.", policy: null };
  }
  const policy = data as MfaPolicy;
  // The database's factor list when available (20261120001100); the browser's session copy is not trusted for it.
  const enrolled = typeof policy.enrolled === "boolean" ? policy.enrolled : (await supabase.auth.mfa.getAuthenticatorAssuranceLevel()).data?.nextLevel === "aal2";
  const reason = policy.platform ? "Platform administrators must use two-step verification." : policy.current_company ? "Your company requires two-step verification." : null;
  return { installed: true, aal, required: Boolean(reason), enrolled, reason, policy };
});

/**
 * True when the person must verify (or set up) a second factor before using this page or action: a policy requires
 * it, or they set up an authenticator themselves (otherwise enrolling would protect nothing).
 */
export async function mfaBlocks(): Promise<boolean> {
  const s = await mfaState();
  return (s.required || s.enrolled) && s.aal !== "aal2";
}

export class MfaRequiredError extends Error {
  constructor() {
    super("Two-step verification is required. Verify with your authenticator app and try again.");
    this.name = "MfaRequiredError";
  }
}
