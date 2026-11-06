"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { dbErrorMessage } from "@/server/errors";
import { assertPlatformStaff } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

// Company access (SA1). Going in needs the company's grant once it is live (the database decides and records it);
// leaving ends the visit at once. Errors come back to the desk as a message.

function back(error: string): never {
  redirect(`/staff?error=${encodeURIComponent(error.slice(0, 300))}`);
}

export async function enterCompany(formData: FormData) {
  await assertPlatformStaff();
  const id = z.uuid().safeParse(formData.get("company"));
  if (!id.success) back("Reload the page and try again.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("platform_support_enter", { p_company: id.data, p_reason: String(formData.get("reason") ?? "").slice(0, 300) });
  if (error) back(dbErrorMessage(error));
  redirect("/command-center");
}

export async function leaveCompany() {
  const supabase = await createClient();
  await supabase.rpc("platform_support_leave");
  redirect("/staff?left=1");
}
