"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { kitFormProblem } from "@/lib/onboarding/kit-validate";
import { integrationConfig, KIT_NOT_INSTALLED } from "@/server/data/onboarding-kit";
import { dbErrorMessage } from "@/server/errors";
import { assertPlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";

// Onboarding kit, Taviron side (platform administrators with a verified second factor; checked again by every
// platform_onboarding_* function). Verification can only be recorded for integrations this server actually has.

const MISSING = ["PGRST202", "42883", "42P01"];
const id = z.uuid();
const saveSchema = z.object({ company: id, form: z.string().max(40), version: z.number().int().min(0), data: z.record(z.string(), z.unknown()) });

/** Bound to one company on the page: staffSaveKitForm.bind(null, companyId). */
export async function staffSaveKitForm(company: string, input: { form: string; version: number; data: Record<string, unknown> }): Promise<ActionResult<{ version: number }>> {
  await assertPlatformAdmin();
  const p = saveSchema.safeParse({ ...input, company });
  if (!p.success) return fail("Check the form.");
  const supabase = await createClient();
  let portal = false;
  if (p.data.form === "integration_checks") {
    const { data } = await supabase.rpc("platform_portal_entitlement", { p_company: p.data.company });
    portal = Boolean((data as { entitled?: boolean } | null)?.entitled);
  }
  const problem = kitFormProblem(p.data.form, p.data.data, "taviron", integrationConfig(portal));
  if (problem) return fail(problem);
  const { data, error } = await supabase.rpc("platform_onboarding_form_save", { p_company: p.data.company, p_form: p.data.form, p_data: p.data.data, p_version: p.data.version });
  if (error) return fail(MISSING.includes(error.code ?? "") ? KIT_NOT_INSTALLED : dbErrorMessage(error));
  revalidatePath(`/admin/onboarding/${p.data.company}`);
  const r = data as { version: number; unchanged: boolean };
  return ok({ version: r.version }, r.unchanged ? "No changes to save." : "Saved.");
}

const signSchema = z.object({ company: id, name: z.string().trim().min(2, "Type your full name.").max(120), title: z.string().trim().max(120).default(""), version: z.number().int().min(1), confirm: z.literal(true) });

export async function staffSignGoLive(company: string, input: { name: string; title: string; version: number; confirm: true }): Promise<ActionResult> {
  await assertPlatformAdmin();
  const p = signSchema.safeParse({ ...input, company });
  if (!p.success) return fail(p.error.issues[0]?.message ?? "Confirm that you verified the evidence.");
  const { error } = await (await createClient()).rpc("platform_onboarding_go_live_sign", { p_company: p.data.company, p_name: p.data.name, p_title: p.data.title, p_version: p.data.version });
  if (error) return fail(MISSING.includes(error.code ?? "") ? KIT_NOT_INSTALLED : dbErrorMessage(error));
  revalidatePath(`/admin/onboarding/${p.data.company}`);
  return ok(undefined, "Taviron's sign-off is recorded.");
}
