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
  const { data, error } = await supabase.rpc("platform_company_delete", { p_company: id, p_confirm_name: String(formData.get("confirm_name") ?? "") });
  if (error) to(id, "error", error.message);
  revalidatePath("/admin", "layout");
  const n = Object.values(((data as { counts?: Record<string, number> } | null)?.counts) ?? {}).reduce((a, b) => a + b, 0);
  redirect(`/admin/companies?deleted=${n}`);
}
