"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { STOP_KEY } from "@/lib/dispatch/wait-times";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { assertPermission, requireAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Wait times (B111): Arrived / Left taps (the load's driver or dispatch) and the company's free time. Track only:
// nothing is billed. The database checks every call again.

// The pickup, the job site, or one of the order's stops (MK2, "stop:<id>"); the database checks it is on the load.
const stopKey = z.union([z.enum(["pickup", "site"]), z.string().regex(STOP_KEY)]);
const mark = z.object({ load: z.uuid(), stop: stopKey, event: z.enum(["arrive", "depart"]) });

export async function markStop(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const p = mark.safeParse({ load: formData.get("load"), stop: formData.get("stop"), event: formData.get("event") });
    if (!p.success) return fail("Invalid stop.");
    const { error } = await (await createClient()).rpc("load_stop_mark", { p_load: p.data.load, p_stop: p.data.stop, p_event: p.data.event });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/driver");
    revalidatePath("/reports/wait-times");
    return ok(undefined, `${p.data.event === "arrive" ? "Arrived" : "Left"} ${p.data.stop === "pickup" ? "pickup" : p.data.stop === "site" ? "job site" : "stop"} recorded.`);
  });
}

const markAt = z.object({ load: z.uuid(), stop: stopKey, event: z.enum(["arrive", "depart"]), at: z.iso.datetime({ offset: true }) });

/**
 * An Arrived / Left tap made without signal and sent later from the phone (B133): the tapped time is kept, within the
 * limits the database enforces (load_stop_mark_at: at most 16 hours back, never in the future).
 */
export async function markStopAt(input: z.input<typeof markAt>): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const p = markAt.safeParse(input);
    if (!p.success) return fail("Invalid stop.");
    const { error } = await (await createClient()).rpc("load_stop_mark_at", { p_load: p.data.load, p_stop: p.data.stop, p_event: p.data.event, p_at: p.data.at });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/driver");
    revalidatePath("/reports/wait-times");
    return ok(undefined, "Recorded.");
  });
}

const UNDO_MISSING = new Set(["42883", "PGRST202"]);

/**
 * The driver takes back their own last Arrived / Left tap (migration 20261120011000): the database allows it only for
 * the load's driver, their own tap, today, within 10 minutes, Left before Arrived. Before the migration is installed it
 * says so and nothing changes.
 */
export async function undoStop(input: z.input<typeof mark>): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const p = mark.safeParse(input);
    if (!p.success) return fail("Invalid stop.");
    const { error } = await (await createClient()).rpc("load_stop_undo", { p_load: p.data.load, p_stop: p.data.stop, p_event: p.data.event });
    if (error) return fail(UNDO_MISSING.has(error.code ?? "") ? "Undo is not available yet. Ask the office to correct the time." : dbErrorMessage(error));
    revalidatePath("/driver");
    revalidatePath("/reports/wait-times");
    return ok(undefined, `${p.data.event === "arrive" ? "Arrived" : "Left"} taken back.`);
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
