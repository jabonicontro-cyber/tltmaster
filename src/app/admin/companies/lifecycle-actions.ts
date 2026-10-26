"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

// Company classification, archive, restore and permanent delete (20261120000500). Platform owner only — checked here
// and again in each database function, which also enforces the rules (practice + archived + exact name to delete).

const uuid = z.uuid();
const to = (id: string, key: string, value: string): never => redirect(`/admin/companies/${id}?${key}=${encodeURIComponent(value.slice(0, 300))}`);

async function db() {
  await assertPlatformAdmin();
  return createClient();
}

function idOf(formData: FormData): string {
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) redirect("/admin/companies");
  return id.data;
}

export async function classifyCompany(formData: FormData) {
  const id = idOf(formData);
  const supabase = await db();
  const { error } = await supabase.rpc("platform_company_classify", { p_company: id, p_class: String(formData.get("classification") ?? "") });
  if (error) to(id, "error", error.message);
  revalidatePath("/admin", "layout");
  to(id, "saved", "classified");
}

export async function archiveCompany(formData: FormData) {
  const id = idOf(formData);
  if (formData.get("confirm") !== "on") to(id, "error", "Confirm that its people lose access until it is restored.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_company_archive", { p_company: id, p_reason: String(formData.get("reason") ?? "") });
  if (error) to(id, "error", error.message);
  revalidatePath("/admin", "layout");
  to(id, "saved", "archived");
}

export async function restoreCompany(formData: FormData) {
  const id = idOf(formData);
  const supabase = await db();
  const { error } = await supabase.rpc("platform_company_restore", { p_company: id });
  if (error) to(id, "error", error.message);
  revalidatePath("/admin", "layout");
  to(id, "saved", "restored");
}

export async function deleteCompany(formData: FormData) {
  const id = idOf(formData);
  const supabase = await db();
  // Also refused here: a database with 20261120000500 but not 000600 has no switch, and delete stays off there too.
  const { data: preview } = await supabase.rpc("platform_company_delete_preview", { p_company: id });
  if ((preview as { delete_enabled?: boolean } | null)?.delete_enabled !== true) to(id, "error", "Permanent delete is turned off on this database until the platform owner enables it.");
  const { data, error } = await supabase.rpc("platform_company_delete", { p_company: id, p_confirm_name: String(formData.get("confirm_name") ?? "") });
  if (error) to(id, "error", error.message);
  revalidatePath("/admin", "layout");
  const n = Object.values(((data as { counts?: Record<string, number> } | null)?.counts) ?? {}).reduce((a, b) => a + b, 0);
  redirect(`/admin/companies?deleted=${n}`);
}

/** Customer portal entitlement (B66): the platform owner's decision; the company then turns its portal on itself. */
export async function setPortalEntitlement(formData: FormData) {
  const id = idOf(formData);
  const supabase = await db();
  const entitled = formData.get("entitled") === "yes";
  const { error } = await supabase.rpc("platform_portal_set_entitlement", { p_company: id, p_entitled: entitled, p_note: String(formData.get("note") ?? "") });
  if (error) to(id, "error", error.message);
  revalidatePath("/admin", "layout");
  redirect(`/admin/companies/${id}?saved=${entitled ? "portal_on" : "portal_off"}`);
}

/** Hired trucks add-on (B83): the platform owner's switch per company. */
export async function setHiredTrucks(formData: FormData) {
  const id = idOf(formData);
  const supabase = await db();
  const entitled = formData.get("entitled") === "yes";
  const { error } = await supabase.rpc("platform_hired_trucks_set", { p_company: id, p_entitled: entitled, p_note: String(formData.get("note") ?? "") });
  if (error) to(id, "error", error.message);
  revalidatePath("/admin", "layout");
  redirect(`/admin/companies/${id}?saved=${entitled ? "hired_on" : "hired_off"}`);
}
