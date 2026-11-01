"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { assertPermission, requireAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Wait times (B111): Arrived / Left taps (the load's driver or dispatch) and the company's free time. Track only:
// nothing is billed. The database checks every call again.

const mark = z.object({ load: z.uuid(), stop: z.enum(["pickup", "site"]), event: z.enum(["arrive", "depart"]) });

export async function markStop(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const p = mark.safeParse({ load: formData.get("load"), stop: formData.get("stop"), event: formData.get("event") });
    if (!p.success) return fail("Invalid stop.");
    const { error } = await (await createClient()).rpc("load_stop_mark", { p_load: p.data.load, p_stop: p.data.stop, p_event: p.data.event });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/driver");
    revalidatePath("/reports/wait-times");
    return ok(undefined, `${p.data.event === "arrive" ? "Arrived" : "Left"} ${p.data.stop === "pickup" ? "pickup" : "job site"} recorded.`);
  });
}

export async function saveWaitSettings(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    const raw = String(formData.get("free_minutes") ?? "").trim();
    const minutes = raw === "" ? null : Number(raw);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 5 || minutes > 480)) return fail("Free time is 5 to 480 minutes, or empty for none.");
    const { error } = await (await createClient()).rpc("wait_time_save_settings", { p_free_minutes: minutes });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    revalidatePath("/reports/wait-times");
    return ok(undefined, minutes === null ? "No free time set: waits are shown, none flagged." : `Waits over ${minutes} minutes are flagged.`);
  });
}
