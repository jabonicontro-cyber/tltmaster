"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { requireAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Taviron support access (SA1, owner 2026-11-06: "customer picks"). Only a real owner of the company gives or ends it
// (a Taviron team member inside the company cannot); the database checks that again and records it in the audit log.

async function owner() {
  const access = await requireAccess();
  if (access.role !== "owner" || access.support) throw new Error("Only an owner of the company can change Taviron support access.");
  return access;
}

export async function grantSupportAccess(formData: FormData): Promise<ActionResult<{ endsAt: string }>> {
  return guard(async () => {
    await owner();
    const days = Number(formData.get("days"));
    if (![1, 3, 7].includes(days)) return fail("Choose 1, 3 or 7 days.");
    const { data, error } = await (await createClient()).rpc("support_access_grant", { p_days: days });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok({ endsAt: String(data) }, `Taviron support can come in for ${days} ${days === 1 ? "day" : "days"}.`);
  });
}

export async function endSupportAccess(): Promise<ActionResult> {
  return guard(async () => {
    await owner();
    const { error } = await (await createClient()).rpc("support_access_end");
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok(undefined, "Taviron support access ended. Anyone from Taviron in your account has been signed out of it.");
  });
}
