"use server";

import { revalidatePath } from "next/cache";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Revenue leakage finder (B110): marking a finding checked or showing it again. Nothing is billed or changed.

export async function checkLeak(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const key = String(formData.get("key") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (reason.length < 3) return fail("Say why this is fine.");
    const { error } = await (await createClient()).rpc("revenue_leak_check", { p_key: key, p_kind: key.split(":")[0], p_reason: reason });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/billing/leaks");
    revalidatePath("/command-center");
    return ok(undefined, "Marked as checked. It comes back if the amount changes.");
  });
}

export async function reopenLeak(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("billing.manage");
    const { error } = await (await createClient()).rpc("revenue_leak_reopen", { p_key: String(formData.get("key") ?? "") });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/billing/leaks");
    revalidatePath("/command-center");
    return ok(undefined, "Shown again.");
  });
}
