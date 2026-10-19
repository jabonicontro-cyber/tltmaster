"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isOperationalDate, OPERATIONAL_DATE_MESSAGE } from "@/lib/dates";
import { ONBOARDING_STATUSES } from "@/lib/onboarding/tasks";
import { dbErrorMessage } from "@/server/errors";
import { onboardingIntegrations } from "@/server/onboarding-integrations";
import { assertPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

// Guided onboarding, Taviron side (platform administrators with a verified second factor; checked here and again in
// every platform_onboarding_* database function). Approving here never changes the lifecycle (go-live date, stage,
// fees) or billing.

const id = z.uuid();
const pathOf = (company: string) => `/admin/onboarding/${company}`;

async function db() {
  await assertPlatformAdmin();
  return createClient();
}

export async function generateOnboarding(formData: FormData): Promise<ActionResult<{ added: number }>> {
  const company = id.safeParse(formData.get("company"));
  if (!company.success) return fail("Company not found.");
  const supabase = await db();
  const { data, error } = await supabase.rpc("platform_onboarding_generate", { p_company: company.data, p_integrations: onboardingIntegrations() });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(pathOf(company.data));
  const added = Number(data ?? 0);
  return ok({ added }, added ? `${added} task${added === 1 ? "" : "s"} added to the checklist.` : "The checklist is up to date: nothing new to add.");
}

const statusSchema = z.object({ company: id, task: id, status: z.enum(ONBOARDING_STATUSES), note: z.string().trim().max(1000).default("") });

export async function staffSetOnboardingStatus(formData: FormData): Promise<ActionResult> {
  const parsed = statusSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail("Check the form.");
  const supabase = await db();
  const { error } = await supabase.rpc("platform_onboarding_set_status", { p_task: parsed.data.task, p_status: parsed.data.status, p_note: parsed.data.note });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(pathOf(parsed.data.company));
  return ok(undefined, "Saved.");
}

const commentSchema = z.object({ company: id, task: id, body: z.string().trim().min(1, "Write a message.").max(2000), internal: z.string().optional() });

export async function staffCommentOnOnboarding(formData: FormData): Promise<ActionResult> {
  const parsed = commentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
  const supabase = await db();
  const internal = parsed.data.internal === "on";
  const { error } = await supabase.rpc("platform_onboarding_comment", { p_task: parsed.data.task, p_body: parsed.data.body, p_internal: internal });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(pathOf(parsed.data.company));
  return ok(undefined, internal ? "Internal note added (not shown to the company)." : "Message sent to the company (in-app).");
}

const taskSchema = z.object({ company: id, task: id });

export async function remindOnboardingTask(formData: FormData): Promise<ActionResult> {
  const parsed = taskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail("Task not found.");
  const supabase = await db();
  const { data, error } = await supabase.rpc("platform_onboarding_remind", { p_task: parsed.data.task });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(pathOf(parsed.data.company));
  const n = Number(data ?? 0);
  return ok(undefined, n ? `In-app reminder sent to ${n} ${n === 1 ? "person" : "people"}. No email was sent.` : "Nobody to remind: the company has no active owner or assignee.");
}

const assignSchema = z.object({ company: id, task: id, due_on: z.string().default("").refine((v) => v === "" || isOperationalDate(v), OPERATIONAL_DATE_MESSAGE), assignee: z.union([id, z.literal("")]).default("") });

export async function staffAssignOnboardingTask(formData: FormData): Promise<ActionResult> {
  const parsed = assignSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the date.");
  const supabase = await db();
  const { error } = await supabase.rpc("onboarding_assign", { p_task: parsed.data.task, p_user: parsed.data.assignee || null, p_due: parsed.data.due_on || null });
  if (error) return fail(dbErrorMessage(error));
  revalidatePath(pathOf(parsed.data.company));
  return ok(undefined, "Saved.");
}
