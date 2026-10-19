"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";
import { ONBOARDING_STATUSES } from "@/lib/onboarding/tasks";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Guided onboarding, company side (settings.manage). The database (private.onboarding_change) decides which status
// changes are allowed: a reviewed task is only ever submitted from here, never approved.

const PATH = "/setup";
const id = z.uuid();

const statusSchema = z.object({ task: id, status: z.enum(ONBOARDING_STATUSES), note: z.string().trim().max(1000).default("") });

export async function setOnboardingStatus(formData: FormData): Promise<ActionResult> {
  await assertPermission("settings.manage");
  const parsed = statusSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail("Check the form.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("onboarding_set_status", { p_task: parsed.data.task, p_status: parsed.data.status, p_note: parsed.data.note });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(PATH);
  return ok(undefined, "Saved.");
}

const commentSchema = z.object({ task: id, body: z.string().trim().min(1, "Write a message.").max(2000) });

export async function commentOnOnboarding(formData: FormData): Promise<ActionResult> {
  await assertPermission("settings.manage");
  const parsed = commentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("onboarding_comment", { p_task: parsed.data.task, p_body: parsed.data.body });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(PATH);
  return ok(undefined, "Message added.");
}

const assignSchema = z.object({ task: id, assignee: z.union([id, z.literal("")]).default(""), due_on: z.string().default("").refine((v) => v === "" || isOperationalDate(v), OPERATIONAL_DATE_MESSAGE) });

export async function assignOnboardingTask(formData: FormData): Promise<ActionResult> {
  await assertPermission("settings.manage");
  const parsed = assignSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the person and the date.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("onboarding_assign", { p_task: parsed.data.task, p_user: parsed.data.assignee || null, p_due: parsed.data.due_on || null });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(PATH);
  return ok(undefined, "Saved.");
}
