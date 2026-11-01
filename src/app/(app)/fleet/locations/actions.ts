"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { parseClock } from "@/lib/telematics";
import { assertPermission, requireAccess } from "@/server/auth";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";
import { generateFeedKey } from "@/server/telematics";

// GPS and hours (B101). Every action is checked again by the database (migration 20261120004900).

const revalidate = () => {
  revalidatePath("/fleet/locations");
  revalidatePath("/settings");
};

export async function saveTelematicsSettings(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    const source = String(formData.get("source") ?? "");
    const stale = Number(formData.get("stale_minutes"));
    if (!["none", "manual", "feed"].includes(source)) return fail("Choose where positions and hours come from.");
    if (!Number.isInteger(stale) || stale < 5 || stale > 1440) return fail("Data counts as current for 5 to 1440 minutes.");
    const { error } = await (await createClient()).rpc("telematics_save_settings", { p_source: source, p_stale_minutes: stale });
    if (error) return fail(dbErrorMessage(error));
    revalidate();
    return ok(undefined, source === "none" ? "GPS and hours are off." : "GPS and hours settings saved.");
  });
}

/** Creates a feed key and returns it once; only its hash is stored. Any earlier key stops working. */
export async function createFeedKey(): Promise<ActionResult<{ key: string }>> {
  return guard(async () => {
    await assertPermission("settings.manage");
    const { key, hash, hint } = generateFeedKey();
    const { error } = await (await createClient()).rpc("telematics_set_feed_key", { p_hash: hash, p_hint: hint });
    if (error) return fail(dbErrorMessage(error));
    revalidate();
    return ok({ key }, "Feed key created. Copy it now: it is not shown again.");
  });
}

export async function revokeFeedKey(): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("settings.manage");
    const { error } = await (await createClient()).rpc("telematics_revoke_feed_key");
    if (error) return fail(dbErrorMessage(error));
    revalidate();
    return ok(undefined, "Feed key revoked. The provider can no longer send data.");
  });
}

const positionInput = z.object({
  truck: z.uuid(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  note: z.string().max(200).default(""),
});

export async function recordPosition(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = positionInput.safeParse({
      truck: formData.get("truck"), latitude: String(formData.get("latitude") ?? "").trim() || "x",
      longitude: String(formData.get("longitude") ?? "").trim() || "x", note: String(formData.get("note") ?? ""),
    });
    if (!parsed.success) return fail("Choose a truck and enter a latitude (−90 to 90) and longitude (−180 to 180).");
    const { error } = await (await createClient()).rpc("telematics_record_position", {
      p_truck: parsed.data.truck, p_latitude: parsed.data.latitude, p_longitude: parsed.data.longitude, p_note: parsed.data.note.trim(),
    });
    if (error) return fail(dbErrorMessage(error));
    revalidate();
    return ok(undefined, "Location recorded.");
  });
}

const DUTY = ["off_duty", "sleeper", "driving", "on_duty"] as const;

/** Hours entered by hand: dispatch for any driver, or a driver for themselves (the database decides). */
export async function recordHours(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const driver = z.uuid().safeParse(formData.get("driver"));
    const duty = z.enum(DUTY).safeParse(formData.get("duty_status"));
    if (!driver.success) return fail("Choose a driver.");
    if (!duty.success) return fail("Choose the duty status.");
    const drive = parseClock(String(formData.get("drive") ?? ""), 24);
    const shift = parseClock(String(formData.get("shift") ?? ""), 24);
    const cycle = parseClock(String(formData.get("cycle") ?? ""), 168);
    if (drive === "bad" || shift === "bad" || cycle === "bad") return fail("Enter time left as hours and minutes, like 5:30 or 11.");
    const { error } = await (await createClient()).rpc("telematics_record_hours", {
      p_driver: driver.data, p_duty_status: duty.data, p_drive_minutes_left: drive, p_shift_minutes_left: shift, p_cycle_minutes_left: cycle,
    });
    if (error) return fail(dbErrorMessage(error));
    revalidate();
    revalidatePath("/my-day");
    return ok(undefined, "Hours recorded.");
  });
}
