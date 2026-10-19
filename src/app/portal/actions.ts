"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SHARED_DEVICE_COOKIE } from "@/lib/shared-device";
import { z } from "zod";
import { createClient } from "@/server/supabase/server";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { safeNextPath } from "@/lib/safe-redirect";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isPortalSlug, isPortalToken } from "@/lib/portal";
import { signInAddress } from "@/lib/usernames";
import { portalError } from "@/server/portal";
import { getEmailMode } from "@/server/email/provider";
import { env } from "@/server/env";
import { forgetPendingPortalInvite, rememberPendingPortalInvite } from "@/server/portal-invite";

// Customer portal actions (B66). Each one passes only the slug and the record the customer chose; the database
// functions decide whether this signed-in customer may act on it. A refusal returns the database's own message only
// when it is one of ours (portalError), never internal details.

const slugOf = (fd: FormData) => {
  const slug = String(fd.get("slug") ?? "");
  if (!isPortalSlug(slug)) throw new Error("Not available.");
  return slug;
};

const signInSchema = z.object({ email: z.string().max(254), password: z.string().min(1, "Enter your password.") });

/**
 * Portal sign-in with an email or a username the company created (docs/ACCOUNT_PROVISIONING.md): an existing account
 * only. Not the early-access gate (customers never see Taviron's preview). A first sign-in with a temporary password
 * is sent to "Create your password" by the portal gate.
 */
export async function signInToPortal(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
  const address = signInAddress(parsed.data.email);
  if (!address.ok) return fail(address.error);
  const jar = await cookies();
  if (formData.get("shared_device") === "on") jar.set(SHARED_DEVICE_COOKIE, "1", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  else jar.delete(SHARED_DEVICE_COOKIE);
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: address.email, password: parsed.data.password });
  if (error) {
    if (error.status === 429) return fail("Too many attempts. Wait a minute and try again.");
    // Reported only after the password matched, so it reveals nothing to a stranger.
    if (error.code === "user_banned") return fail("This sign-in is turned off. Contact the company that gave it to you.");
    return fail(parsed.data.email.includes("@") ? "Email or password is incorrect." : "Username or password is incorrect.");
  }
  // Back to the page they asked for, but only inside this portal.
  const base = `/portal/${slug}`;
  const next = safeNextPath(String(formData.get("next") ?? ""), base);
  redirect(next === base || next.startsWith(`${base}/`) ? next : base);
}

export async function signOutOfPortal(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const supabase = await createClient();
  await supabase.auth.signOut();
  (await cookies()).delete(SHARED_DEVICE_COOKIE);
  redirect(isPortalSlug(slug) ? `/portal/${slug}/login` : "/login");
}

/**
 * A new person asks for their account. We never create a confirmed account for an address on the strength of the
 * invitation link alone (whoever holds the link is not proven to own the address — security review 2026-10-19 F1):
 * Supabase Auth emails the address its own invitation link; opening it proves ownership, the person chooses a password,
 * and comes back here to accept. Demo companies never create accounts or send email.
 */
export async function requestPortalAccount(formData: FormData): Promise<ActionResult> {
  const token = String(formData.get("token") ?? "");
  if (!isPortalToken(token)) return fail("This invitation link is not valid.");
  const supabase = await createClient();
  const { data: peek } = await supabase.rpc("portal_invite_peek", { p_token: token });
  const invite = peek as { email: string; expired: boolean; demo?: boolean } | null;
  if (!invite || invite.expired) return fail("This invitation is not valid any more. Ask for a new one.");
  if (invite.demo) return fail("This is a demo company: its portal is previewed from the Testing Lab. No account is created and nothing is emailed.");
  const mode = getEmailMode();
  if (mode.mode === "test" && invite.email.toLowerCase() !== mode.testRecipient.toLowerCase()) {
    return fail("Email test mode is on on this server: sign-in links go only to the test inbox. Please contact the company.");
  }
  if (!adminAvailable()) return fail("Accounts cannot be created on this server yet. Please contact us.");
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.inviteUserByEmail(invite.email, { redirectTo: `${env().APP_BASE_URL}/auth/confirm?next=/update-password` });
  if (error) {
    // An account already exists for this email: they sign in with it (never reset or take it over here).
    if (/already|registered|exists/i.test(error.message)) return fail("You already have an account. Sign in first, then open this link again.");
    console.warn("Portal account email failed", { status: error.status });
    return fail("We could not send the email. Please try again or contact us.");
  }
  await rememberPendingPortalInvite(token);
  return ok(undefined, `We sent a sign-in link to ${invite.email}. Open it in this browser, choose a password, and you will come back here to finish.`);
}

/** Accept an invitation as the signed-in person; the database requires the account's email to match the invitation. */
export async function acceptPortalInvite(formData: FormData): Promise<ActionResult> {
  const token = String(formData.get("token") ?? "");
  if (!isPortalToken(token)) return fail("This invitation link is not valid.");
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return fail("Sign in first, then open this link again.");
  const { data, error } = await supabase.rpc("portal_accept", { p_token: token });
  if (error) return fail(portalError(error));
  await forgetPendingPortalInvite();
  redirect(`/portal/${(data as { slug: string }).slug}`);
}

const requestSchema = z.object({
  material: z.string().trim().min(1, "Tell us which material you need.").max(200),
  quantity: z.string().trim().max(20).optional(),
  unit: z.string().trim().max(30).optional(),
  requested_date: z.string().trim().max(10).optional(),
  site_id: z.string().trim().optional(),
  site_text: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export async function requestQuote(formData: FormData): Promise<ActionResult<{ id: string; duplicate: boolean }>> {
  const slug = slugOf(formData);
  const parsed = requestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
  if (parsed.data.quantity && !/^\d+(\.\d+)?$/.test(parsed.data.quantity)) return fail("Enter the quantity as a number.", { quantity: "Enter a number." });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_request_quote", { p_slug: slug, p: parsed.data });
  if (error) return fail(portalError(error));
  revalidatePath(`/portal/${slug}/quotes`);
  const r = data as { id: string; duplicate: boolean };
  return ok(r, r.duplicate ? "We already have this request — no duplicate was created." : "Request sent. We will reply with a quote.");
}

export async function respondToQuote(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const quote = String(formData.get("quote") ?? "");
  const accept = formData.get("answer") === "accept";
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return fail("Type your name to confirm.", { name: "Type your name." });
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_quote_respond", { p_slug: slug, p_quote: quote, p_accept: accept, p_name: name, p_note: String(formData.get("note") ?? "") });
  if (error) return fail(portalError(error));
  revalidatePath(`/portal/${slug}/quotes`);
  return ok(undefined, accept ? "Thank you. We will confirm your acceptance shortly." : "Thank you for letting us know.");
}

export async function createSupportRequest(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const slug = slugOf(formData);
  const order = String(formData.get("order") ?? "") || null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_support_create", {
    p_slug: slug, p_subject: String(formData.get("subject") ?? ""), p_message: String(formData.get("message") ?? ""), p_order: order,
  });
  if (error) return fail(portalError(error));
  const id = (data as { id: string }).id;
  redirect(`/portal/${slug}/support/${id}?sent=1`);
}

export async function replyToSupport(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const request = String(formData.get("request") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_support_reply", { p_slug: slug, p_request: request, p_body: String(formData.get("body") ?? "") });
  if (error) return fail(portalError(error));
  revalidatePath(`/portal/${slug}/support/${request}`);
  return ok(undefined, "Message sent.");
}

export async function voteOnArticle(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_help_vote", { p_slug: slug, p_article: String(formData.get("article") ?? ""), p_helpful: formData.get("helpful") === "yes" });
  if (error) return fail(portalError(error));
  return ok(undefined, "Thanks for the feedback.");
}
