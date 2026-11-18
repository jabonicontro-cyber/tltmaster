"use server";

import { revalidatePath } from "next/cache";
import { SIGNIN_LIMIT_MESSAGE, recordSignInFailure, signInAllowed } from "@/server/signin-limit";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SHARED_DEVICE_COOKIE, wantsBrowserSession } from "@/lib/shared-device";
import { z } from "zod";
import { createClient } from "@/server/supabase/server";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { safeNextPath } from "@/lib/safe-redirect";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isPortalSlug, isPortalToken, supportFormErrors } from "@/lib/portal";
import { isUsernameEmail, signInAddress } from "@/lib/usernames";
import { portalError, portalPublic } from "@/server/portal";
import { getEmailMode } from "@/server/email/provider";
import { env } from "@/server/env";
import { PORTAL_RETURN, forgetPendingPortalInvite, rememberPendingPortalInvite } from "@/server/portal-invite";

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
  if (wantsBrowserSession(formData)) jar.set(SHARED_DEVICE_COOKIE, "1", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  else jar.delete(SHARED_DEVICE_COOKIE);
  if (!(await signInAllowed(address.email))) return fail(SIGNIN_LIMIT_MESSAGE);
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: address.email, password: parsed.data.password });
  if (error && (error.status === 400 || error.code === "invalid_credentials")) await recordSignInFailure(address.email);
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

const resetEmail = z.email("Enter the email address you sign in with.");

/**
 * "Forgot your password?" on a portal's sign-in page (owner 2026-11-17, master plan §12 PR1): for accounts invited by
 * email. Supabase Auth emails its own reset link (the same template and link as the app's reset); the person chooses
 * a new password and comes back to this portal. The answer is the same whether or not the address has a sign-in here,
 * and a failed send is only logged, so nobody can learn who has an account. A username has no mailbox: it keeps
 * "ask the company", with that reason. Requests per address are limited like failed sign-ins (8 in 15 minutes).
 * Portal accounts stay what they are (not memberships); only the password changes.
 */
export async function requestPortalPasswordReset(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const card = await portalPublic(slug);
  if (!card) return fail("This portal is not available.");
  const raw = String(formData.get("email") ?? "").trim();
  const usernameReason = `A username has no email address, so no reset link can be sent to it. Ask ${card.name} for a new sign-in. Nobody there can see your password.`;
  if (raw && !raw.includes("@")) return fail(usernameReason, { email: "This looks like a username." });
  const parsed = resetEmail.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the email address.", { email: "Enter an email address." });
  const email = parsed.data.toLowerCase();
  if (isUsernameEmail(email)) return fail(usernameReason);
  if (card.is_demo) return fail("This is a demo company: its portal does not send email. Nothing was sent.");
  const limitKey = `portal-reset:${email}`;
  if (!(await signInAllowed(limitKey))) return fail("Too many reset requests for this email. Wait 15 minutes and try again.");
  await recordSignInFailure(limitKey);
  // Back to this portal after the new password is saved (same browser). Set for every request, so the answer never
  // differs between an address with a sign-in and one without.
  (await cookies()).set(PORTAL_RETURN, slug, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 3600, path: "/" });
  if (await hasPortalSignIn(slug, email)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${env().APP_BASE_URL}/auth/confirm?next=/update-password` });
    if (error) console.warn("Portal password reset email failed", { status: error.status, code: error.code });
  }
  return ok(undefined, `If ${email} has a sign-in for this portal, a link to choose a new password is on its way. It can take a few minutes; check the spam folder too.`);
}

/**
 * Does this portal have an active sign-in for this email (invited by email and accepted)? Read with the service key
 * because the person is signed out; only a yes or no is used, and it is never shown. Without the key the reset is sent
 * as the app's own reset does (Supabase sends nothing to an address without an account).
 */
async function hasPortalSignIn(slug: string, email: string): Promise<boolean> {
  if (!adminAvailable()) return true;
  const admin = createAdminClient();
  const { data: company } = await admin.from("companies").select("id").eq("slug", slug).eq("active", true).maybeSingle();
  if (!company) return false;
  const { data } = await admin
    .from("portal_accounts")
    .select("email, user_id")
    .eq("company_id", (company as { id: string }).id)
    .eq("status", "active")
    .not("user_id", "is", null)
    .ilike("email", email.replace(/[\\%_]/g, (c) => `\\${c}`));
  return ((data ?? []) as Array<{ email: string }>).some((a) => a.email.toLowerCase() === email);
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
  return ok(r, r.duplicate ? "We already have this request. No duplicate was created." : "Request sent. We will reply with a quote.");
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

export async function createSupportRequest(formData: FormData): Promise<ActionResult<{ id: string; messageId: string | null }>> {
  const slug = slugOf(formData);
  const val = (k: string) => String(formData.get(k) ?? "") || null;
  // The same checks the form shows next to each field; the database checks them again.
  const missing = supportFormErrors({ kind: String(formData.get("kind") ?? ""), subject: String(formData.get("subject") ?? ""), message: String(formData.get("message") ?? "") });
  if (Object.keys(missing).length) return fail("Some answers are missing. See the marked fields.", missing);
  const supabase = await createClient();
  // The support center (B138): case type and optional order, ticket or invoice; the original function before that
  // update is installed.
  let { data, error } = await supabase.rpc("portal_support_open", {
    p_slug: slug, p_kind: String(formData.get("kind") ?? ""), p_subject: String(formData.get("subject") ?? ""), p_message: String(formData.get("message") ?? ""),
    p_order: val("order"), p_ticket: val("ticket"), p_invoice: val("invoice"),
  });
  if (error?.code === "PGRST202") {
    ({ data, error } = await supabase.rpc("portal_support_create", {
      p_slug: slug, p_subject: String(formData.get("subject") ?? ""), p_message: String(formData.get("message") ?? ""), p_order: val("order"),
    }));
  }
  if (error) return fail(portalError(error));
  const r = data as { id: string; message_id?: string };
  revalidatePath(`/portal/${slug}/support`);
  return ok({ id: r.id, messageId: r.message_id ?? null }, "Sent.");
}

export async function replyToSupport(formData: FormData): Promise<ActionResult<{ messageId: string | null }>> {
  const slug = slugOf(formData);
  const request = String(formData.get("request") ?? "");
  const body = String(formData.get("body") ?? "");
  const supabase = await createClient();
  let { data, error } = await supabase.rpc("portal_support_send", { p_slug: slug, p_request: request, p_body: body });
  if (error?.code === "PGRST202") ({ data, error } = await supabase.rpc("portal_support_reply", { p_slug: slug, p_request: request, p_body: body }));
  if (error) return fail(portalError(error));
  revalidatePath(`/portal/${slug}/support/${request}`);
  return ok({ messageId: typeof data === "string" ? data : null }, "Message sent.");
}

export async function voteOnArticle(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_help_vote", { p_slug: slug, p_article: String(formData.get("article") ?? ""), p_helpful: formData.get("helpful") === "yes" });
  if (error) return fail(portalError(error));
  return ok(undefined, "Thanks for the feedback.");
}

/** Job-site notes from the customer (B94): goes to the office for review; nothing reaches drivers until applied. */
export async function submitSiteInfo(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const slug = slugOf(formData);
  const text = (k: string) => String(formData.get(k) ?? "");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_site_info_submit", {
    p_slug: slug, p_site: text("site"), p_gate: text("gate"), p_drop: text("drop"), p_contact: text("contact"), p_phone: text("phone"), p_notes: text("notes"),
  });
  if (error) return fail(portalError(error));
  revalidatePath(`/portal/${slug}/sites`);
  return ok({ id: data as string }, "Sent to the office. They check it before drivers see it.");
}

// Customer self-booking (B115): requests only; the company's dispatch approves each one.
const bookingSchema = z.object({
  day: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose one of the open days."),
  loads: z.string().trim().regex(/^\d{1,3}$/, "Enter the number of loads."),
  material: z.string().trim().min(1, "Tell us what you need hauled.").max(200),
  site_id: z.string().trim().optional(),
  time_window: z.enum(["any", "morning", "afternoon"]).default("any"),
  notes: z.string().trim().max(2000).optional(),
});

export async function requestBooking(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const slug = slugOf(formData);
  const parsed = bookingSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_booking_request", { p_slug: slug, p: { ...parsed.data, site_id: parsed.data.site_id || null } });
  if (error) return fail(portalError(error));
  revalidatePath(`/portal/${slug}/book`);
  return ok(data as { id: string }, "Request sent. You will see here when it is approved.");
}

export async function cancelBooking(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_booking_cancel", { p_slug: slug, p_request: String(formData.get("request") ?? "") });
  if (error) return fail(portalError(error));
  revalidatePath(`/portal/${slug}/book`);
  return ok(undefined, "Request withdrawn.");
}

/** The customer's site contact releases a truck working for the day on their order (UX11). */
export async function releasePortalTruck(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const load = String(formData.get("load") ?? "");
  const order = String(formData.get("order") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(load)) return fail("Truck not found.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("portal_truck_release", { p_slug: slug, p_load: load });
  if (error) return fail(portalError(error));
  if (/^[0-9a-f-]{36}$/.test(order)) revalidatePath(`/portal/${slug}/orders/${order}`);
  return ok(undefined, "Truck released. Thank you.");
}
