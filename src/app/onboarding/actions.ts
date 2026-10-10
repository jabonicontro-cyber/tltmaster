"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { ACCESS_CODE_ERRORS, looksLikeAccessCode } from "@/lib/early-access";
import { getAccess } from "@/server/auth";
import { accessCodeHash, clientIp, rateKey } from "@/server/early-access";
import { dbErrorMessage } from "@/server/errors";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

const nameSchema = z.string().trim().min(2, "Enter the company name (2 to 120 characters).").max(120);

/** Finish sign-up: the reserved company, owner membership and active company in one transaction. */
export async function completeOnboarding(formData: FormData): Promise<ActionResult> {
  const name = nameSchema.safeParse(formData.get("companyName"));
  if (!name.success) return { ok: false, error: name.error.issues[0].message, fieldErrors: { companyName: name.error.issues[0].message } };
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_company_onboarding", { p_company_name: name.data });
  if (error) return { ok: false, error: dbErrorMessage(error) };
  revalidatePath("/", "layout");
  redirect("/dashboard?welcome=1");
}

const createSchema = z.object({
  accessCode: z.string().trim().min(1, "Enter your access code."),
  companyName: nameSchema,
  requestKey: z.uuid(),
});

/** An existing account creates another company with an access code (idempotent per form). */
export async function createAnotherCompany(formData: FormData): Promise<ActionResult> {
  const access = await getAccess();
  if (!access) redirect("/login");
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  const codeHash = looksLikeAccessCode(parsed.data.accessCode) ? accessCodeHash(parsed.data.accessCode) : "0".repeat(64);

  // Per-IP and per-email limits (server, service role); the database also limits per user.
  if (adminAvailable()) {
    const check = await createAdminClient().rpc("early_access_check", { p_code_hash: codeHash, p_ip_hash: rateKey(await clientIp()), p_email_hash: rateKey(access.email) });
    const c = check.data as { ok: boolean; reason: string } | null;
    if (check.error || !c) return { ok: false, error: "Company creation is temporarily unavailable. Try again later." };
    if (!c.ok) return { ok: false, error: ACCESS_CODE_ERRORS[c.reason] ?? ACCESS_CODE_ERRORS.unknown };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_company_with_access_code", {
    p_code_hash: codeHash, p_company_name: parsed.data.companyName, p_request_key: parsed.data.requestKey,
  });
  if (error) return { ok: false, error: dbErrorMessage(error) };
  const r = data as { ok: boolean; reason?: string };
  if (!r.ok) return { ok: false, error: ACCESS_CODE_ERRORS[r.reason ?? ""] ?? ACCESS_CODE_ERRORS.unknown };
  revalidatePath("/", "layout");
  redirect("/dashboard?welcome=1");
}
