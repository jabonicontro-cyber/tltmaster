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
