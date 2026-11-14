"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, guard } from "@/server/errors";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

// Accepting an invitation to be a company's first owner (PC2). The invitation link is the only key: a sign-in is
// created only for the invited email and only while the invitation is open; accepting needs a verified authenticator
// app, and the database checks the email, the app and that the company still has no owner (owner_invite_accept).

export type OwnerInvitePeek = {
  status: "open" | "used" | "withdrawn" | "expired" | "closed" | "invalid";
  email?: string;
  full_name?: string;
  company_name?: string;
  expires_at?: string;
  has_account?: boolean;
};

const tokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export async function peekOwnerInvite(token: string): Promise<OwnerInvitePeek> {
  if (!tokenSchema.safeParse(token).success) return { status: "invalid" };
  const { data, error } = await (await createClient()).rpc("owner_invite_peek", { p_token: token });
  if (error || !data) return { status: "invalid" };
  return data as OwnerInvitePeek;
}

const accountSchema = z.object({
  token: tokenSchema,
  password: z.string().min(12, "Use at least 12 characters.").max(128),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, { message: "The two passwords are not the same.", path: ["confirm"] });

/** Create the invited owner's sign-in (email confirmed by the link), sign them in, then on to the authenticator. */
export async function createOwnerAccount(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const p = accountSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) {
      const issue = p.error.issues[0];
      return fail(issue?.message ?? "Check the form.", issue?.path[0] ? { [String(issue.path[0])]: issue.message } : undefined);
    }
    const inv = await peekOwnerInvite(p.data.token);
    if (inv.status !== "open" || !inv.email) return fail("This invitation is no longer valid. Ask Taviron for a new one.");
    if (inv.has_account) return fail("You already have a Taviron sign-in. Sign in with it to accept.");
    if (!adminAvailable()) return fail("Sign-ins cannot be created on this server yet. Ask Taviron for help.");
    const admin = createAdminClient();
    const created = await admin.auth.admin.createUser({ email: inv.email, password: p.data.password, email_confirm: true, user_metadata: { full_name: inv.full_name ?? "" } });
    if (created.error) return fail("Your sign-in could not be created. Try again, or ask Taviron for a new invitation.");
    const supabase = await createClient();
    const signedIn = await supabase.auth.signInWithPassword({ email: inv.email, password: p.data.password });
    if (signedIn.error) return fail("Your sign-in was created but could not be opened. Sign in with your email and the new password.");
    redirect(`/mfa?next=${encodeURIComponent(`/join-company?token=${p.data.token}`)}`);
  });
}

export async function acceptOwnerInvite(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const token = tokenSchema.safeParse(formData.get("token"));
    if (!token.success) return fail("This invitation link is not complete. Open it again from the email.");
    const { error } = await (await createClient()).rpc("owner_invite_accept", { p_token: token.data });
    if (error) return fail(dbErrorMessage(error));
    redirect("/command-center");
  });
}
