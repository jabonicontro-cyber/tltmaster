"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { env } from "@/server/env";
import { dbErrorMessage, guard } from "@/server/errors";
import { createAccountFromEmailedLink, sendInviteEmailCode, setInvitedPassword, signInForInvite, verifyInviteEmailCode } from "@/server/invite-account";
import { clearInviteToken, readInviteToken } from "@/server/invite-token";
import { createClient } from "@/server/supabase/server";

// Joining the Taviron team (SA1). The invitation link is the only key, kept in an HttpOnly cookie for this page
// (src/lib/invite-cookie.ts). An account is created only for the invited email and only while the invitation is open;
// when the link was not emailed to that address by Taviron, a code emailed by Supabase Auth confirms it first
// (src/server/invite-account.ts). Joining needs a confirmed email and a verified authenticator app (the database checks).

export type InvitePeek = {
  status: "open" | "used" | "withdrawn" | "expired" | "invalid";
  email?: string;
  full_name?: string;
  level?: "admin" | "support";
  expires_at?: string;
  has_account?: boolean;
  /** Taviron's server emailed the link to the invited address (otherwise the page asks for an email code first). */
  link_emailed?: boolean;
};

const PAGE = "/join-team";
const tokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
const NOT_VALID = "This invitation is no longer valid. Ask for a new one.";

export async function peekInvite(token: string): Promise<InvitePeek> {
  if (!tokenSchema.safeParse(token).success) return { status: "invalid" };
  const { data, error } = await (await createClient()).rpc("staff_invite_peek", { p_token: token });
  if (error || !data) return { status: "invalid" };
  return data as InvitePeek;
}

async function openInvite(): Promise<(InvitePeek & { email: string }) | null> {
  const inv = await peekInvite(await readInviteToken(PAGE));
  return inv.status === "open" && inv.email ? (inv as InvitePeek & { email: string }) : null;
}

const password = z.string().min(12, "Use at least 12 characters.").max(128);
const passwordSchema = z.object({ password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "The two passwords are not the same.", path: ["confirm"] });
const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email."), password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { message: "The two passwords are not the same.", path: ["confirm"] });

function formError(issues: ReadonlyArray<{ message: string; path: ReadonlyArray<PropertyKey> }>): ActionResult {
  const issue = issues[0];
  return fail(issue?.message ?? "Check the form.", issue?.path[0] ? { [String(issue.path[0])]: issue.message } : undefined);
}

/** Link emailed by Taviron: create the person's sign-in (email confirmed), sign them in, then on to the authenticator. */
export async function createTeamAccount(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const p = passwordSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) return formError(p.error.issues);
    const inv = await openInvite();
    if (!inv) return fail(NOT_VALID);
    if (inv.has_account) return fail("You already have a Taviron sign-in. Sign in with it to accept.");
    if (!inv.link_emailed) return fail("First confirm your email address with a code. Reload the page.");
    const err = await createAccountFromEmailedLink(inv.email, inv.full_name ?? "", p.data.password);
    if (err) return fail(err);
    redirect(`/mfa?next=${encodeURIComponent(PAGE)}`);
  });
}

export async function sendTeamEmailCode(): Promise<ActionResult> {
  return guard(async () => {
    const inv = await openInvite();
    if (!inv) return fail(NOT_VALID);
    if (inv.has_account) return fail("You already have a Taviron sign-in. Reload the page and sign in with it.");
    const err = await sendInviteEmailCode(inv.email, inv.full_name ?? "", `${env().APP_BASE_URL}${PAGE}`);
    if (err) return fail(err);
    return ok(undefined, `Code sent to ${inv.email}.`);
  });
}

export async function verifyTeamEmailCode(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const p = codeSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) return formError(p.error.issues);
    const inv = await openInvite();
    if (!inv) return fail(NOT_VALID);
    const err = await verifyInviteEmailCode(inv.email, p.data.code, p.data.password);
    if (err) return fail(err, /code/i.test(err) ? { code: "Not correct." } : undefined);
    redirect(`/mfa?next=${encodeURIComponent(PAGE)}`);
  });
}

export async function chooseTeamPassword(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const p = passwordSchema.safeParse(Object.fromEntries(formData));
    if (!p.success) return formError(p.error.issues);
    const inv = await openInvite();
    if (!inv) return fail(NOT_VALID);
    const err = await setInvitedPassword(inv.email, p.data.password);
    if (err) return fail(err);
    redirect(`/mfa?next=${encodeURIComponent(PAGE)}`);
  });
}

/** An existing Taviron sign-in for the invited email, from this page (the early-access gate stays closed elsewhere). */
export async function signInToJoinTeam(formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    const pw = z.string().min(1, "Enter your password.").max(200).safeParse(formData.get("password"));
    if (!pw.success) return fail(pw.error.issues[0]?.message ?? "Enter your password.", { password: "Required." });
    const inv = await openInvite();
    if (!inv) return fail(NOT_VALID);
    const err = await signInForInvite(inv.email, pw.data);
    if (err) return fail(err, { password: err });
    redirect(PAGE);
  });
}

export async function acceptTeamInvite(): Promise<ActionResult> {
  return guard(async () => {
    const token = await readInviteToken(PAGE);
    if (!token) return fail("Open the invitation link from the email again.");
    const { data, error } = await (await createClient()).rpc("platform_staff_accept", { p_token: token });
    if (error) return fail(dbErrorMessage(error));
    await clearInviteToken(PAGE);
    redirect(data === "admin" ? "/admin" : "/staff");
  });
}
