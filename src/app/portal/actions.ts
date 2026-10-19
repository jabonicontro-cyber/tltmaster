"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/server/supabase/server";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { safeNextPath } from "@/lib/safe-redirect";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isPortalSlug, isPortalToken } from "@/lib/portal";
import { portalError } from "@/server/portal";

// Customer portal actions (B66). Each one passes only the slug and the record the customer chose; the database
// functions decide whether this signed-in customer may act on it. A refusal returns the database's own message only
// when it is one of ours (portalError), never internal details.

const slugOf = (fd: FormData) => {
  const slug = String(fd.get("slug") ?? "");
  if (!isPortalSlug(slug)) throw new Error("Not available.");
  return slug;
};

const signInSchema = z.object({ email: z.email("Enter your email address."), password: z.string().min(1, "Enter your password.") });

/** Portal sign-in: an existing account only. Not the early-access gate (customers never see Taviron's preview). */
export async function signInToPortal(formData: FormData): Promise<ActionResult> {
  const slug = slugOf(formData);
  const parsed = signInSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
  if (error) {
    if (error.status === 429) return fail("Too many attempts. Wait a minute and try again.");
    return fail("Email or password is incorrect.");
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
  redirect(isPortalSlug(slug) ? `/portal/${slug}/login` : "/login");
}

const acceptSchema = z.object({
  token: z.string(),
  password: z.string().min(10, "Use at least 10 characters.").max(72, "Use at most 72 characters."),
  confirm: z.string(),
});

/**
 * Accept an invitation. A new person sets a password and their account is created for the invited email only; an
 * existing account must sign in first (we never attach an invitation to an account that did not prove its password).
 */
export async function acceptPortalInvite(formData: FormData): Promise<ActionResult> {
  const token = String(formData.get("token") ?? "");
  if (!isPortalToken(token)) return fail("This invitation link is not valid.");
  const supabase = await createClient();
  const { data: peek } = await supabase.rpc("portal_invite_peek", { p_token: token });
  const invite = peek as { email: string; slug: string; expired: boolean; open: boolean } | null;
  if (!invite || invite.expired) return fail("This invitation is not valid any more. Ask for a new one.");

  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) {
    const parsed = acceptSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form.");
    if (parsed.data.password !== parsed.data.confirm) return fail("The passwords do not match.", { confirm: "The passwords do not match." });
    if (!adminAvailable()) return fail("Accounts cannot be created on this server yet. Please contact us.");
    const admin = createAdminClient();
    const { error: createError } = await admin.auth.admin.createUser({ email: invite.email, password: parsed.data.password, email_confirm: true });
    if (createError) {
      // An account already exists for this email: they must sign in with it (never reset or take it over here).
      if (/already|registered|exists/i.test(createError.message)) return fail("You already have an account. Sign in first, then open this link again.");
      console.warn("Portal account creation failed", { status: createError.status });
      return fail("Your account could not be created. Please try again or contact us.");
    }
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: invite.email, password: parsed.data.password });
    if (signInError) return fail("Your account was created, but signing in failed. Sign in from the portal page.");
  }
  const { data, error } = await supabase.rpc("portal_accept", { p_token: token });
  if (error) return fail(portalError(error));
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
