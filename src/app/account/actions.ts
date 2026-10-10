"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

/**
 * Work in another of the user's companies. The database checks the
 * membership; every query then follows the new active company.
 */
export async function switchCompany(companyId: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(companyId).success) return { ok: false, error: "Invalid company." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("switch_company", { p_company_id: companyId });
  if (error) return { ok: false, error: dbErrorMessage(error) };
  revalidatePath("/", "layout");
  redirect("/command-center");
}
