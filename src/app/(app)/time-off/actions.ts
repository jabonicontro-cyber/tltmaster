"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { uuid } from "@/lib/schemas/common";
import { adjustSchema, bankSchema, hoursSchema, policySchema } from "@/lib/pto";
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
    const r = data as { status: string; step?: number; conflicts: unknown[] };
    refresh(parsed.data.id);
    if (r.status === "pending") return ok({ conflicts: 0 }, `Step approved. The request now waits for step ${r.step}.`);
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

// PTO banks and balances (20261112000100): time_off.balances is checked by the database functions.

function bankInput(formData: FormData) {
  return {
    id: formData.get("id")?.toString() ?? "",
    name: formData.get("name")?.toString() ?? "",
    categories: formData.getAll("categories").map(String),
    employment_types: formData.getAll("employment_types").map(String),
    waiting_days: formData.get("waiting_days")?.toString() || "0",
    active: formData.get("active") !== "false",
  };
}

export async function saveBank(formData: FormData): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await requireAccess();
    const parsed = bankSchema.safeParse(bankInput(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("pto_bank_save", { p: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/time-off", "layout");
    return ok(data as { id: string }, parsed.data.id ? "Bank saved." : "Bank created.");
  });
}

export async function adjustBalance(formData: FormData): Promise<ActionResult<{ balance: number | null }>> {
  return guard(async () => {
    await requireAccess();
    const parsed = adjustSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("pto_adjust", { p: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { duplicate: boolean; balance: number | null };
    revalidatePath("/time-off", "layout");
    return ok({ balance: r.balance === null ? null : Number(r.balance) }, r.duplicate ? "This entry was already recorded." : parsed.data.kind === "grant" ? "Hours granted." : "Balance adjusted.");
  });
}

export async function savePolicy(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const parsed = policySchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = await supabase.rpc("pto_policy_save", { p: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/time-off", "layout");
    return ok(undefined, "Policy saved. Run accruals to post the hours earned so far.");
  });
}

export async function endPolicy(id: string): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    if (!uuid.safeParse(id).success) return fail("Invalid policy.");
    const supabase = await createClient();
    const { error } = await supabase.rpc("pto_policy_end", { p_id: id });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/time-off", "layout");
    return ok(undefined, "Policy turned off. Hours already earned stay.");
  });
}

export async function recordHours(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await requireAccess();
    const parsed = hoursSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("pto_record_hours", { p: parsed.data });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/time-off", "layout");
    return ok(undefined, (data as { duplicate: boolean }).duplicate ? "These hours were already recorded." : "Hours recorded.");
  });
}

export async function runAccruals(): Promise<ActionResult<{ entries: number; hours: number; forfeitures: number }>> {
  return guard(async () => {
    await requireAccess();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("pto_run_accruals", { p_through: null });
    if (error) return fail(dbErrorMessage(error));
    const r = data as { entries: number; hours: number; forfeitures: number };
    revalidatePath("/time-off", "layout");
    return ok(r, r.entries || r.forfeitures ? `Posted ${r.entries} accrual${r.entries === 1 ? "" : "s"} (${Number(Number(r.hours).toFixed(2))} h)${r.forfeitures ? ` and ${r.forfeitures} plan-year forfeiture${r.forfeitures === 1 ? "" : "s"}` : ""}.` : "Nothing new to post — accruals are up to date.");
  });
}
