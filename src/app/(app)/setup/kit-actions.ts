"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { kitFormProblem } from "@/lib/onboarding/kit-validate";
import { assertPermission } from "@/server/auth";
import { KIT_NOT_INSTALLED } from "@/server/data/onboarding-kit";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Onboarding kit, company side (settings.manage in the current company; checked again by the database). The company
// fills the questionnaire, dispatch worksheet, integration owners, testing issues and after-launch notes; Taviron
// records verification and acceptance. Signing the go-live acceptance needs the company owner.

const MISSING = ["PGRST202", "42883", "42P01"];
const saveSchema = z.object({ form: z.string().max(40), version: z.number().int().min(0), data: z.record(z.string(), z.unknown()) });

export async function saveKitForm(input: z.input<typeof saveSchema>): Promise<ActionResult<{ version: number }>> {
  await assertPermission("settings.manage");
  const p = saveSchema.safeParse(input);
  if (!p.success) return fail("Check the form.");
  const problem = kitFormProblem(p.data.form, p.data.data, "company");
  if (problem) return fail(problem);
  const { data, error } = await (await createClient()).rpc("onboarding_form_save", { p_form: p.data.form, p_data: p.data.data, p_version: p.data.version });
  if (error) return fail(MISSING.includes(error.code ?? "") ? KIT_NOT_INSTALLED : dbErrorMessage(error));
  revalidatePath("/setup");
  const r = data as { version: number; unchanged: boolean };
  return ok({ version: r.version }, r.unchanged ? "No changes to save." : "Saved.");
}

const signSchema = z.object({ name: z.string().trim().min(2, "Type your full name.").max(120), title: z.string().trim().max(120).default(""), version: z.number().int().min(1), confirm: z.literal(true) });

export async function signGoLive(input: z.input<typeof signSchema>): Promise<ActionResult> {
  await assertPermission("settings.manage");
  const p = signSchema.safeParse(input);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "Confirm that you reviewed the acceptance.");
  const { error } = await (await createClient()).rpc("onboarding_go_live_sign", { p_name: p.data.name, p_title: p.data.title, p_version: p.data.version });
  if (error) return fail(MISSING.includes(error.code ?? "") ? KIT_NOT_INSTALLED : dbErrorMessage(error));
  revalidatePath("/setup");
  return ok(undefined, "Your sign-off is recorded. Go-live also needs Taviron's sign-off.");
}
