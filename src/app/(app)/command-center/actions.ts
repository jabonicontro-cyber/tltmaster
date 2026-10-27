"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const key = z.string().regex(/^[a-z_]+:[a-z0-9:_-]+$/i, "Invalid item.").max(120);

const assignInput = z.object({
  key,
  userId: z.uuid("Choose a person."),
  note: z.string().trim().max(300).default(""),
});

/** Ask a person to handle an open item. It stays open until its record changes. */
export async function assignException(input: z.input<typeof assignInput>): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("exceptions.assign");
    const parsed = assignInput.safeParse(input);
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("assign_exception", { p_key: parsed.data.key, p_user_id: parsed.data.userId, p_note: parsed.data.note });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/command-center");
    return ok(undefined, `Assigned to ${(data as { assignee: string }).assignee}.`);
  });
}

export async function unassignException(input: { key: string }): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("exceptions.assign");
    const parsed = key.safeParse(input.key);
    if (!parsed.success) return fail("Invalid item.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("unassign_exception", { p_key: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/command-center");
    return ok(undefined, "Assignee removed.");
  });
}

const hideInput = z.object({ key, hours: z.union([z.literal(4), z.literal(24), z.literal(72)]) });

/**
 * Hide a non-urgent item from your own view for a while. It stays open, counted
 * and visible to everyone else; the database refuses to hide urgent items.
 */
export async function hideException(input: z.input<typeof hideInput>): Promise<ActionResult> {
  return guard(async () => {
    const parsed = hideInput.safeParse(input);
    if (!parsed.success) return fail("Invalid item.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("hide_exception", { p_key: parsed.data.key, p_hours: parsed.data.hours });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/command-center");
    return ok(undefined, "Hidden from your view. It is still open for everyone else.");
  });
}

export async function unhideException(input: { key: string }): Promise<ActionResult> {
  return guard(async () => {
    const parsed = key.safeParse(input.key);
    if (!parsed.success) return fail("Invalid item.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("unhide_exception", { p_key: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/command-center");
    return ok(undefined, "Shown again.");
  });
}

const SECTION_IDS = ["outlook", "weather", "my_work", "attention", "operations", "speed", "sales", "activity"] as const;
const layoutInput = z.object({
  order: z.array(z.enum(SECTION_IDS)).max(SECTION_IDS.length),
  collapsed: z.array(z.enum(SECTION_IDS)).max(SECTION_IDS.length),
});

/** Save your own section order and collapsed sections (layout only — never access). */
export async function saveCommandCenterLayout(input: z.input<typeof layoutInput>): Promise<ActionResult> {
  return guard(async () => {
    const parsed = layoutInput.safeParse(input);
    if (!parsed.success) return fail("Invalid layout.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("save_my_preference", { p_key: "command_center", p_value: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    return ok(undefined, "Layout saved.");
  });
}
