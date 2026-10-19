import "server-only";
import type { OnboardingState, OnboardingSummary } from "@/lib/onboarding/tasks";
import { createClient } from "@/server/supabase/server";

// Guided onboarding (20261120001000). Reads go through the database functions: onboarding_state() for the company side
// (settings.manage, own company only) and platform_onboarding() for Taviron. Before the migration is applied the
// functions do not exist and both views show "not available yet" instead of an empty checklist.

export type Loaded<T> = { ok: true; data: T } | { ok: false; reason: "not_installed" | "error"; message: string };

const MISSING = ["PGRST202", "42883", "42P01"];

function failed(error: { code?: string; message: string }): Loaded<never> {
  if (MISSING.includes(error.code ?? "")) return { ok: false, reason: "not_installed", message: "Guided onboarding needs the database update 20261120001000, which is not installed yet." };
  console.error("Onboarding read failed", { code: error.code });
  return { ok: false, reason: "error", message: "The onboarding checklist could not be loaded right now. Nothing was changed; try again in a moment." };
}

/** The signed-in company's checklist (company side). */
export async function companyOnboarding(): Promise<Loaded<OnboardingState>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("onboarding_state");
  if (error) return failed(error);
  return { ok: true, data: data as OnboardingState };
}

/** A company's checklist with Taviron's internal notes (platform administrators). */
export async function platformOnboarding(companyId: string): Promise<Loaded<OnboardingState>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_onboarding", { p_company: companyId });
  if (error) return failed(error);
  return { ok: true, data: data as OnboardingState };
}

export type OnboardingOverviewRow = { company_id: string; name: string; is_demo: boolean; summary: OnboardingSummary };

/** Every company with a checklist and its counts (platform administrators). */
export async function platformOnboardingOverview(): Promise<Loaded<OnboardingOverviewRow[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("platform_onboarding_overview");
  if (error) return failed(error);
  return { ok: true, data: (data ?? []) as OnboardingOverviewRow[] };
}
