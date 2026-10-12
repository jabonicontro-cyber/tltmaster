"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { uuid } from "@/lib/schemas/common";
import { timeOffSchema } from "@/lib/time-off";
import { requireAccess } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Every rule (own record or time_off.approve, never deciding one's own request,
// overlaps, dates) is enforced by the database functions; these actions
// validate input and translate errors.

function refresh(id?: string) {
  revalidatePath("/time-off", "layout");
  revalidatePath("/dispatch", "layout");
  if (id) revalidatePath(`/time-off/${id}`);
}

export async function submitTimeOff(formData: FormData): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await requireAccess();
    const parsed = timeOffSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("time_off_save", { p: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { id: string; duplicate: boolean };
    refresh(r.id);
    return ok({ id: r.id }, r.duplicate ? "This request was already sent." : "Time-off request sent.");
  });
}

const decision = z.object({ id: uuid, decision: z.enum(["approved", "denied"]), note: z.string().trim().max(1000).default("") });

export async function decideTimeOff(input: z.input<typeof decision>): Promise<ActionResult<{ conflicts: number }>> {
  return guard(async () => {
    await requireAccess();
    const parsed = decision.safeParse(input);
    if (!parsed.success) return fail("Invalid request.");
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("time_off_decide", { p_id: parsed.data.id, p_decision: parsed.data.decision, p_note: parsed.data.note });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { conflicts: unknown[] };
    refresh(parsed.data.id);
    const n = r.conflicts?.length ?? 0;
    return ok({ conflicts: n }, parsed.data.decision === "denied" ? "Request denied." : n ? `Approved. ${n} assignment${n === 1 ? "" : "s"} overlap this leave — review them in Dispatch.` : "Request approved.");
  });
}

const cancel = z.object({ id: uuid, note: z.string().trim().max(1000).default("") });

export async function cancelTimeOff(input: z.input<typeof cancel>): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const parsed = cancel.safeParse(input);
    if (!parsed.success) return fail("Invalid request.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("time_off_cancel", { p_id: parsed.data.id, p_note: parsed.data.note });
    if (error) return fail(dbErrorMessage(error));
    refresh(parsed.data.id);
    return ok(undefined, "Request canceled.");
  });
}
