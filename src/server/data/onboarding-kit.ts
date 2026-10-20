import "server-only";
import type { KitForm } from "@/lib/onboarding/kit";
import { getEmailMode } from "@/server/email/provider";
import { onboardingIntegrations } from "@/server/onboarding-integrations";
import { createClient } from "@/server/supabase/server";
import type { Loaded } from "./onboarding";

// Customer Onboarding Kit (20261120001500). Reads go through onboarding_kit() (company side: settings.manage, own
// company) and platform_onboarding_kit() (Taviron). Before the migration both views say the update is needed.

export interface KitFormState { data: Record<string, unknown>; version: number; updated_at: string; updated_by: string }
export interface KitSignoff { id: string; party: "company" | "taviron"; signer_name: string; signer_title: string; go_live_version: number; signed_at: string; exceptions: unknown[]; current: boolean }
export interface KitState {
  forms: Partial<Record<KitForm, KitFormState>>;
  signoffs: KitSignoff[];
  blockers: string[];
  accepted: boolean;
  gated: boolean;
  lifecycle: { stage: string; go_live_on: string | null; live_at: string | null } | null;
}

const MISSING = ["PGRST202", "42883", "42P01"];
export const KIT_NOT_INSTALLED = "The onboarding kit needs the database update 20261120001500, which is not installed yet.";

function failed(error: { code?: string; message: string }): Loaded<never> {
  if (MISSING.includes(error.code ?? "")) return { ok: false, reason: "not_installed", message: KIT_NOT_INSTALLED };
  console.error("Onboarding kit read failed", { code: error.code });
  return { ok: false, reason: "error", message: "The onboarding kit could not be loaded right now. Nothing was changed; try again in a moment." };
}

export async function companyKit(): Promise<Loaded<KitState>> {
  const { data, error } = await (await createClient()).rpc("onboarding_kit");
  return error ? failed(error) : { ok: true, data: data as KitState };
}

export async function platformKit(companyId: string): Promise<Loaded<KitState>> {
  const { data, error } = await (await createClient()).rpc("platform_onboarding_kit", { p_company: companyId });
  return error ? failed(error) : { ok: true, data: data as KitState };
}

/** What this server has configured (booleans only), so a check can never say "verified" for something not set up. */
export function integrationConfig(portalEntitled: boolean): Record<"email" | "routing" | "ai" | "portal", boolean> {
  const i = onboardingIntegrations();
  return { email: getEmailMode().mode === "live", routing: i.routing, ai: i.ai, portal: portalEntitled };
}
