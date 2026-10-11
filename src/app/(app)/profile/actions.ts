"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { sniffImage } from "@/lib/branding";
import { MAX_PHOTO_BYTES } from "@/lib/people/photo";
import { isCompletePhone } from "@/lib/phone";
import { requireAccess } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const profileSchema = z.object({
  display_name: z.string().trim().max(60, "Use at most 60 characters."),
  phone: z
    .string()
    .trim()
    .max(25, "Use at most 25 characters.")
    .regex(/^[0-9+()./ -]*$/, "Use digits, spaces and + ( ) - . only.")
    .refine(isCompletePhone, "Enter the whole number, e.g. (312) 555-0142, or leave it empty."),
});

/** The signed-in person's own display name and phone. Nothing else can be changed here. */
export async function updateMyProfile(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const parsed = profileSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("update_my_profile", { p_display_name: parsed.data.display_name, p_phone: parsed.data.phone });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/", "layout");
    return ok(undefined, "Profile saved.");
  });
}

/**
 * Upload or replace the signed-in person's photo. The browser has already
 * resized it; the server checks the real type from the bytes and the size, and
 * the database checks both again.
 */
export async function uploadMyPhoto(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const file = formData.get("photo");
    if (!(file instanceof File) || file.size === 0) return fail("Choose a photo first.", { photo: "Choose a photo first." });
    if (file.size > MAX_PHOTO_BYTES) return fail("The photo is too large.", { photo: "Use a smaller photo (200 KB at most after resizing)." });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniffImage(bytes);
    if (!kind) return fail("Use a JPEG, PNG or WebP photo.", { photo: "Use a JPEG, PNG or WebP photo." });
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_my_photo", { p_mime_type: `image/${kind}`, p_data_base64: Buffer.from(bytes).toString("base64") });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/", "layout");
    return ok(undefined, "Photo saved.");
  });
}

export async function removeMyPhoto(): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const supabase = await createClient();
    const { error } = await supabase.rpc("set_my_photo", { p_mime_type: null, p_data_base64: null });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/", "layout");
    return ok(undefined, "Photo removed.");
  });
}
