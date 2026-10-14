import "server-only";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { can, type Access, type AppRole } from "@/lib/permissions";
import { dbErrorMessage } from "@/server/errors";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";
import { env } from "@/server/env";
import { getEmailMode } from "@/server/email/provider";

export interface InviteInput { email: string; full_name: string; role: AppRole; /** The person's record to link, when known. */ employeeId?: string }

const DEPARTMENT_FOR_ROLE: Record<AppRole, string> = { owner: "management", dispatcher: "dispatch", office: "office", mechanic: "shop", driver: "operations" };

/**
 * Every sign-in is a person (owner 2026-10-14): link the login to the given record, else to an unlinked record with
 * the same work email, else create one. Needs employees.edit (RLS); without it the login simply has no record yet and
 * the next person with that permission sees it in the Directory backfill. Never fails the invitation.
 */
async function ensurePersonRecord(access: Access, userId: string, input: InviteInput): Promise<void> {
  if (!can(access, "employees.edit")) return;
  const supabase = await createClient();
  const { data: linked } = await supabase.from("employees").select("id").eq("user_id", userId).limit(1);
  if (linked?.length) return;
  if (input.employeeId) {
    const r = await supabase.from("employees").update({ user_id: userId }).eq("id", input.employeeId).is("user_id", null).select("id");
    if (r.data?.length) return;
  }
  const { data: same } = await supabase.from("employees").select("id").is("user_id", null).ilike("work_email", input.email.replace(/[\\%_]/g, (c) => `\\${c}`)).order("created_at").limit(1);
  if (same?.length) {
    await supabase.from("employees").update({ user_id: userId }).eq("id", (same[0] as { id: string }).id).is("user_id", null);
    return;
  }
  await supabase.from("employees").insert({ user_id: userId, full_name: input.full_name, work_email: input.email, department: DEPARTMENT_FOR_ROLE[input.role], status: "active" });
}

/**
 * Give a person a Taviron sign-in in the caller's company (users.manage, checked by the caller and again by the
 * database functions). Someone who already has an account is added directly; anyone else gets Supabase Auth's
 * invitation email. Demo companies never send anything. Used by People (add person, Sign-ins & roles).
 * Returns the login's user id when the person is now a member.
 */
export async function inviteMember(access: Access, input: InviteInput): Promise<ActionResult<{ userId: string | null }>> {
  if (access.isDemo) return fail("Invitations are turned off in the demo company: it never sends email to anyone.");
  if (input.role === "owner" && access.role !== "owner") return fail("Only an owner can add another owner.");
  const supabase = await createClient();

  // Someone who already has an account (for example in another company) is
  // added to this company directly — no second account, no new password.
  const existing = await supabase.rpc("add_existing_member", {
    p_email: input.email,
    p_role: input.role,
    p_full_name: input.full_name,
  });
  if (existing.error) return fail(dbErrorMessage(existing.error));
  const found = existing.data as { found: boolean; already?: boolean; user_id?: string };
  if (found.found) {
    if (found.user_id) await ensurePersonRecord(access, found.user_id, input);
    return ok(
      { userId: found.user_id ?? null },
      found.already
        ? `${input.email} is already a member of your company.`
        : `${input.email} already has an account and was added to your company. They can switch to it from the account menu after signing in.`,
    );
  }

  // Invitations are emailed by Supabase Auth, not by Resend, so EMAIL_TEST_RECIPIENT cannot
  // redirect them. While test mode is on they may only go to the test inbox itself.
  const mode = getEmailMode();
  if (mode.mode === "test" && input.email.toLowerCase() !== mode.testRecipient.toLowerCase()) {
    return fail(`Email test mode is on: invitations can only be sent to the test inbox (${mode.testRecipient}) until EMAIL_TEST_RECIPIENT is removed.`);
  }
  if (!adminAvailable()) {
    return fail("Inviting users needs SUPABASE_SERVICE_ROLE_KEY on the server. Until then, add users in the Supabase dashboard (Authentication → Users) and assign their role here.");
  }
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
    data: { full_name: input.full_name },
    redirectTo: `${env().APP_BASE_URL}/auth/confirm?next=/update-password`,
  });
  if (error) {
    return fail(/already/i.test(error.message) ? "An account with this email was just created. Try the invitation again." : `The invitation could not be sent: ${error.message}`);
  }
  // Membership in the inviter's company is created by the permission-checked
  // database function, running as the inviting user (never the service role).
  const { error: roleErr } = await supabase.rpc("add_company_member", {
    p_user_id: data.user.id,
    p_role: input.role,
    p_full_name: input.full_name,
  });
  if (roleErr) return fail(`Invitation sent, but the user could not be added to your company: ${dbErrorMessage(roleErr)}`);
  await ensurePersonRecord(access, data.user.id, input);
  console.info("User invited", { by: access.userId, user: data.user.id });
  return ok({ userId: data.user.id }, `Invitation sent to ${input.email}.`);
}
