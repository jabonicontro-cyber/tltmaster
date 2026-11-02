"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isOperationalDate } from "@/lib/dates";
import { isUsernameEmail } from "@/lib/usernames";
import { requireAccess } from "@/server/auth";
import { emailSetupLink, issueSetup, loginUrl, reserveAndCreate } from "@/server/accounts";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Accountant access (B134). Only an owner gives, changes or ends it; the database checks that again
// (private.require_owner) and records every change. The sign-in is made by the same provisioning as employees';
// its temporary password is returned once to the owner and never stored.

async function owner() {
  const access = await requireAccess();
  if (access.role !== "owner") throw new Error("Only an owner can give or change an accountant's access.");
  return access;
}

const inviteSchema = z.object({
  request_key: z.uuid(),
  full_name: z.string().trim().min(2, "Enter the accountant's name.").max(120),
  username: z.string().trim().min(3, "Choose a username.").max(32),
  email: z.union([z.email("Enter a valid email or leave it empty."), z.literal("")]).default(""),
  ends_on: z.string().refine(isOperationalDate, "Choose the last day of access."),
  payroll: z.enum(["on", ""]).default(""),
});

export interface InvitedAccountant { userId: string; username: string; temporaryPassword: string; expiresAt: string; personName: string; loginUrl: string; email: string }

export async function inviteAccountant(formData: FormData): Promise<ActionResult<InvitedAccountant>> {
  return guard(async () => {
    const access = await owner();
    if (access.isDemo) return fail("Demo companies do not create sign-ins: nothing real is created from a demo.");
    const p = inviteSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) {
      const issue = p.error.issues[0];
      return fail(issue?.message ?? "Check the form.", issue?.path[0] ? { [String(issue.path[0])]: issue.message } : undefined);
    }
    const v = p.data;
    if (v.email && isUsernameEmail(v.email)) return fail("Enter the accountant's own email, or leave it empty.", { email: "Enter their own email." });
    const created = await reserveAndCreate("employee", v.request_key, v.username, v.full_name);
    if (!created.ok) return created.error.includes("taken") ? fail(created.error, { username: created.error }) : created;
    const { userId, username, temporaryPassword } = created.data;
    const { error } = await (await createClient()).rpc("accountant_grant", { p_user: userId, p_full_name: v.full_name, p_ends_on: v.ends_on, p_payroll: v.payroll === "on" });
    if (error) return fail(dbErrorMessage(error));
    const issued = await issueSetup("employee", userId, "print");
    if (!issued.ok) return issued;
    revalidatePath("/settings");
    return ok({ userId, username, temporaryPassword, expiresAt: issued.data.expiresAt, personName: v.full_name, loginUrl: loginUrl("employee"), email: v.email }, "Accountant sign-in created.");
  });
}

export async function emailAccountantSetup(userId: string, to: string): Promise<ActionResult<{ reference: string | null }>> {
  return guard(async () => {
    const access = await owner();
    if (!z.uuid().safeParse(userId).success || !z.email().safeParse(to).success) return fail("Enter a valid email.");
    const { data: person } = await (await createClient()).from("profiles").select("full_name").eq("id", userId).maybeSingle();
    return emailSetupLink("employee", userId, to, { isDemo: Boolean(access.isDemo), personName: (person as { full_name?: string } | null)?.full_name ?? "there", companyName: access.companyName ?? "Your company" });
  });
}

const changeSchema = z.object({
  user_id: z.uuid(),
  ends_on: z.string().default(""),
  payroll: z.enum(["on", ""]).default(""),
  end_now: z.enum(["1", ""]).default(""),
});

export async function changeAccountantAccess(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await owner();
    const p = changeSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) return fail("Check the form.");
    const v = p.data;
    const endNow = v.end_now === "1";
    if (!endNow && !isOperationalDate(v.ends_on)) return fail("Choose the last day of access.", { ends_on: "Choose the last day of access." });
    const { error } = await (await createClient()).rpc("accountant_set_access", { p_user: v.user_id, p_ends_on: endNow ? null : v.ends_on, p_payroll: v.payroll === "on", p_end_now: endNow });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath("/settings");
    return ok(undefined, endNow ? "Access ended. The accountant can no longer sign in to the company." : "Access updated.");
  });
}
