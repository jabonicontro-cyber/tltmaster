"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, guard } from "@/server/errors";
import { createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

// Joining the Taviron team (SA1). The invitation link is the only key: an account is created only for the invited
// email and only while the invitation is open; joining needs a verified authenticator app (the database checks).

export type InvitePeek = { status: "open" | "used" | "withdrawn" | "expired" | "invalid"; email?: string; full_name?: string; level?: "admin" | "support"; expires_at?: string; has_account?: boolean };

const tokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export async function peekInvite(token: string): Promise<InvitePeek> {
  if (!tokenSchema.safeParse(token).success) return { status: "invalid" };
  const { data, error } = await (await createClient()).rpc("staff_invite_peek", { p_token: token });
  if (error || !data) return { status: "invalid" };
  return data as InvitePeek;
}

const accountSchema = z.object({
  token: tokenSchema,
  password: z.string().min(12, "Use at least 12 characters.").max(128),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { message: "The two passwords are not the same.", path: ["confirm"] });

/** Create the invited person's sign-in (email confirmed by the link), sign them in, then on to the authenticator. */
export async function createTeamAccount(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const p = accountSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) {
      const issue = p.error.issues[0];
      return fail(issue?.message ?? "Check the form.", issue?.path[0] ? { [String(issue.path[0])]: issue.message } : undefined);
    }
    const inv = await peekInvite(p.data.token);
    if (inv.status !== "open" || !inv.email) return fail("This invitation is no longer valid. Ask for a new one.");
    if (inv.has_account) return fail("You already have a Taviron sign-in. Sign in with it to accept.");
    const admin = createAdminClient();
    const created = await admin.auth.admin.createUser({ email: inv.email, password: p.data.password, email_confirm: true, user_metadata: { full_name: inv.full_name ?? "" } });
    if (created.error) return fail("Your sign-in could not be created. Try again, or ask for a new invitation.");
    const supabase = await createClient();
    const signedIn = await supabase.auth.signInWithPassword({ email: inv.email, password: p.data.password });
    if (signedIn.error) return fail("Your sign-in was created but could not be opened. Sign in with your email and the new password.");
    redirect(`/mfa?next=${encodeURIComponent(`/join-team?token=${p.data.token}`)}`);
  });
}

export async function acceptTeamInvite(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const token = tokenSchema.safeParse(formData.get("token"));
    if (!token.success) return fail("This invitation link is not complete. Open it again from the email.");
    const { data, error } = await (await createClient()).rpc("platform_staff_accept", { p_token: token.data });
    if (error) return fail(dbErrorMessage(error));
    redirect(data === "admin" ? "/admin" : "/staff");
  });
}
