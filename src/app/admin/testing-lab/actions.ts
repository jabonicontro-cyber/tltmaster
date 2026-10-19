"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PREVIEW_COOKIE, parsePreviewRole } from "@/lib/platform/preview";
import { assertPlatformAdmin } from "@/server/platform";
import { requestIsHttps } from "@/server/site-access-request";
import { createClient } from "@/server/supabase/server";

// Testing Lab (B66). Platform owner only — checked here and in every platform_* database function. Every action works
// on a DEMO company: the database refuses previews, checks and role views for real companies.

const uuid = z.uuid();
const LAB = "/admin/testing-lab";
const back = (company: string | null, error: string): never => redirect(`${LAB}?${company ? `demo=${company}&` : ""}error=${encodeURIComponent(error.slice(0, 300))}`);

async function db() {
  await assertPlatformAdmin();
  return createClient();
}

/**
 * Open a demo company's workspace as one of its roles: switch into the demo (you must be one of its members) and set
 * the role view, which only ever narrows your own permissions (src/lib/platform/preview.ts). "self" = your own view.
 */
export async function openDemoAs(formData: FormData) {
  const company = uuid.safeParse(formData.get("company"));
  if (!company.success) back(null, "Choose a demo company.");
  const supabase = await db();
  const { data: demo, error } = await supabase.rpc("platform_testing_demo", { p_company: company.data });
  if (error || !demo) back(company.data!, "Only demo companies can be opened from the Testing Lab.");
  const sw = await supabase.rpc("switch_company", { p_company_id: company.data });
  if (sw.error) back(company.data!, "You are not a member of this demo. Open it once from Demo Management (or recreate it) first.");
  const jar = await cookies();
  const role = parsePreviewRole(String(formData.get("role") ?? ""));
  if (role) jar.set(PREVIEW_COOKIE, role, { httpOnly: true, sameSite: "lax", secure: await requestIsHttps(), path: "/", maxAge: 60 * 60 * 8 });
  else jar.delete(PREVIEW_COOKIE);
  revalidatePath("/", "layout");
  redirect(role === "driver" ? "/driver" : String(formData.get("to") ?? "") === "help" ? "/help" : "/command-center");
}

/** See a demo company's customer portal as one of its demo customers, for one hour (audited; demo companies only). */
export async function previewPortalAs(formData: FormData) {
  const company = uuid.safeParse(formData.get("company"));
  const customer = uuid.safeParse(formData.get("customer"));
  if (!company.success || !customer.success) back(company.success ? company.data : null, "Choose a demo customer.");
  const supabase = await db();
  const { data, error } = await supabase.rpc("platform_portal_preview_start", { p_company: company.data, p_customer: customer.data });
  if (error) back(company.data!, error.message);
  redirect(`/portal/${(data as { slug: string }).slug}`);
}

export async function stopPortalPreview(formData: FormData) {
  const supabase = await db();
  await supabase.rpc("platform_portal_preview_stop");
  const company = uuid.safeParse(formData.get("company"));
  redirect(company.success ? `${LAB}?demo=${company.data}` : LAB);
}

/** Turn a demo's portal on with a public page (fictional company; nothing is sent). */
export async function openDemoPortal(formData: FormData) {
  const company = uuid.safeParse(formData.get("company"));
  if (!company.success) back(null, "Choose a demo company.");
  const supabase = await db();
  const { data: demo } = await supabase.rpc("platform_testing_demo", { p_company: company.data });
  if (!demo) back(company.data!, "Only demo companies.");
  const ent = await supabase.rpc("platform_portal_set_entitlement", { p_company: company.data, p_entitled: true, p_note: "Demo (Testing Lab)" });
  if (ent.error) back(company.data!, ent.error.message);
  const sw = await supabase.rpc("switch_company", { p_company_id: company.data });
  if (sw.error) back(company.data!, "You are not a member of this demo, so its portal settings cannot be changed from here.");
  const { data: state } = await supabase.rpc("portal_admin_state");
  const current = ((state as { settings?: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown>;
  const { error } = await supabase.rpc("portal_save_settings", { p: { ...current, enabled: true, public_page: true, feature_tracking: true } });
  if (error) back(company.data!, error.message);
  revalidatePath(LAB);
  redirect(`${LAB}?demo=${company.data}&saved=portal`);
}

export async function recordCheck(formData: FormData) {
  const view = String(formData.get("view") ?? "");
  const company = uuid.safeParse(formData.get("company"));
  const supabase = await db();
  const { error } = await supabase.rpc("platform_testing_record", {
    p_view: view, p_company: company.success ? company.data : null, p_status: String(formData.get("status") ?? ""), p_note: String(formData.get("note") ?? ""),
  });
  if (error) back(company.success ? company.data : null, error.message);
  revalidatePath(LAB);
  redirect(`${LAB}?${company.success ? `demo=${company.data}&` : ""}saved=check#check-${view}`);
}
