"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isOperationalDate } from "@/lib/dates";
import { dollarsToCents } from "@/lib/platform/lifecycle";
import { dbErrorMessage } from "@/server/errors";
import { assertPlatformAdmin, requirePlatformAdmin } from "@/server/platform";
import { confirmPassword } from "@/server/reauth";
import { createClient } from "@/server/supabase/server";

// Customer lifecycle actions (20261118000300). Platform admins only: checked here and again in every database function.
// Nothing here charges, invoices or contacts anyone; amounts are records of what was agreed or received elsewhere.

const uuid = z.uuid();
const go = (path: string, key: "saved" | "error", value: string): never =>
  redirect(`${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value.slice(0, 300))}`);

async function db() {
  await assertPlatformAdmin();
  return createClient();
}

function companyPath(formData: FormData): { id: string; path: string } {
  const id = uuid.safeParse(formData.get("company"));
  if (!id.success) redirect("/admin/companies");
  return { id: id.data, path: `/admin/companies/${id.data}` };
}

export async function acknowledgeAttention(formData: FormData) {
  const supabase = await db();
  const key = String(formData.get("key") ?? "");
  const { error } = await supabase.rpc("platform_attention_ack", { p_key: key, p_note: String(formData.get("note") ?? "").slice(0, 300) });
  if (error) go("/admin", "error", dbErrorMessage(error));
  revalidatePath("/admin");
  go("/admin", "saved", "ack");
}

export async function setLifecycleTerms(formData: FormData) {
  const { id, path } = companyPath(formData);
  const supabase = await db();
  const agreedText = String(formData.get("agreed_monthly") ?? "").trim();
  const agreed = agreedText ? dollarsToCents(agreedText) : null;
  if (agreedText && agreed === null) go(path, "error", "Enter the agreed monthly amount in dollars, e.g. 399.20.");
  const { error } = await supabase.rpc("platform_lifecycle_terms", {
    p_company: id,
    p: {
      plan_version_id: String(formData.get("plan_version_id") ?? ""),
      terms: String(formData.get("terms") ?? ""),
      offer: String(formData.get("offer") ?? ""),
      agreed_monthly_cents: agreed === null ? "" : String(agreed),
      notes: String(formData.get("notes") ?? "").slice(0, 2000),
    },
  });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  go(path, "saved", "terms");
}

export async function recordOnboardingFee(formData: FormData) {
  const { id, path } = companyPath(formData);
  const supabase = await db();
  const status = String(formData.get("status") ?? "");
  const { error } = await supabase.rpc("platform_lifecycle_fee", { p_company: id, p_status: status, p_note: String(formData.get("note") ?? "") });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  go(path, "saved", "fee");
}

export async function setGoLiveDate(formData: FormData) {
  const { id, path } = companyPath(formData);
  const supabase = await db();
  const day = String(formData.get("go_live_on") ?? "");
  if (!isOperationalDate(day)) go(path, "error", "Enter the go-live date.");
  const { error } = await supabase.rpc("platform_lifecycle_go_live_on", { p_company: id, p_date: day });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  go(path, "saved", "golive_date");
}

/** Go Live Now: the platform admin enters their password again; the database checks the fresh sign-in too. */
export async function goLiveNow(formData: FormData) {
  const { id, path } = companyPath(formData);
  const me = await requirePlatformAdmin();
  if (formData.get("confirm") !== "on") go(path, "error", "Tick the box to confirm the company goes live now.");
  const ok = await confirmPassword(me.email, String(formData.get("password") ?? ""));
  if (!ok) go(path, "error", "That password is not correct. Nothing was changed.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_lifecycle_go_live_now", { p_company: id });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  revalidatePath("/admin");
  go(path, "saved", "live");
}

export async function cancelSubscription(formData: FormData) {
  const { id, path } = companyPath(formData);
  const supabase = await db();
  const balance = Number(formData.get("balance_cents"));
  if (formData.get("confirm") !== "on") go(path, "error", "Tick the box to confirm the cancellation and its balance.");
  if (!Number.isInteger(balance)) go(path, "error", "Reload the page and try again.");
  const { error } = await supabase.rpc("platform_lifecycle_cancel", { p_company: id, p_reason: String(formData.get("reason") ?? ""), p_confirm_balance_cents: balance });
  if (error) go(path, "error", dbErrorMessage(error));
  revalidatePath(path);
  go(path, "saved", "canceled");
}

export async function createPlanVersion(formData: FormData) {
  const supabase = await db();
  const key = String(formData.get("plan_key") ?? "");
  const monthlyText = String(formData.get("monthly") ?? "");
  const onboardingText = String(formData.get("onboarding") ?? "");
  const monthly = dollarsToCents(monthlyText);
  const onboarding = dollarsToCents(onboardingText);
  if (key !== "custom" && (monthly === null || onboarding === null)) go("/admin/plans", "error", "Enter the monthly price and the onboarding fee in dollars.");
  const from = String(formData.get("effective_from") ?? "");
  if (!isOperationalDate(from)) go("/admin/plans", "error", "Enter the first day of the new price.");
  if (formData.get("confirm") !== "on") go("/admin/plans", "error", "Tick the box to confirm the new price.");
  const { error } = await supabase.rpc("platform_plan_version_create", {
    p: { plan_key: key, monthly_cents: monthly === null ? "" : String(monthly), onboarding_cents: onboarding === null ? "" : String(onboarding), effective_from: from, note: String(formData.get("note") ?? "").slice(0, 500) },
  });
  if (error) go("/admin/plans", "error", dbErrorMessage(error));
  revalidatePath("/admin/plans");
  go("/admin/plans", "saved", "version");
}
