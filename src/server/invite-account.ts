import "server-only";
import { randomBytes } from "node:crypto";
import { SIGNIN_LIMIT_MESSAGE, recordSignInFailure, signInAllowed } from "@/server/signin-limit";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

// The sign-in for an invitation to be a company's first owner (/join-company) or to join the Taviron team (/join-team).
// Holding the invitation link does not prove the person owns the invited mailbox (security review 2026-11-16): the
// link may have been handed over instead of emailed. So:
//   * Link emailed by Taviron's server to that address (the database records it; never test mode): the person
//     chooses a password and the sign-in is created with the email confirmed, as before.
//   * Otherwise: the sign-in is created UNCONFIRMED (nobody can sign in with it), Supabase Auth emails a 6-digit code
//     to the invited address with its own mailer (resend, type "signup"; signInWithOtp refuses unconfirmed addresses
//     while public sign-up is off), and only the code (verifyOtp, type "email") confirms the address and signs the
//     person in; then they choose their password. Accepting checks the confirmed email again in the database.
// The invited email always comes from the invitation, never from the form.

export const INVITE_PASSWORD_FLAG = "invite_set_password";

const CODE_SENT_RECENTLY = "A code was sent less than a minute ago. Check your email, or wait a minute and ask for a new one.";

type Admin = ReturnType<typeof createAdminClient>;

/** An existing sign-in for the email: its id and whether the address is confirmed. */
async function findAccount(admin: Admin, email: string): Promise<{ id: string; confirmed: boolean } | null> {
  const { data } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  const id = (data as { id: string } | null)?.id;
  if (!id) return null;
  const { data: u } = await admin.auth.admin.getUserById(id);
  if (!u.user || u.user.email?.toLowerCase() !== email) return null;
  return { id, confirmed: Boolean(u.user.email_confirmed_at) };
}

const randomPassword = () => `${randomBytes(32).toString("base64url")}Aa1!`;

/**
 * The link was emailed to this address by Taviron: create the sign-in with the email confirmed and the chosen
 * password, then sign in. An earlier unconfirmed sign-in for the address (never usable) gets the chosen password.
 */
export async function createAccountFromEmailedLink(email: string, fullName: string, password: string): Promise<string | null> {
  if (!adminAvailable()) return "Sign-ins cannot be created on this server yet. Ask Taviron for help.";
  const admin = createAdminClient();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (created.error) {
    const existing = created.error.code === "email_exists" ? await findAccount(admin, email) : null;
    if (existing?.confirmed) return "You already have a Taviron sign-in. Sign in with it to accept.";
    if (!existing) return "Your sign-in could not be created. Try again, or ask for a new invitation.";
    const updated = await admin.auth.admin.updateUserById(existing.id, { password, email_confirm: true, app_metadata: { [INVITE_PASSWORD_FLAG]: null } });
    if (updated.error) return "Your sign-in could not be created. Try again, or ask for a new invitation.";
  }
  const signedIn = await (await createClient()).auth.signInWithPassword({ email, password });
  if (signedIn.error) return "Your sign-in was created but could not be opened. Sign in with your email and the new password.";
  return null;
}

/**
 * The link was not emailed by Taviron: make sure an unconfirmed sign-in exists for the address (a random password
 * nobody knows; an earlier unconfirmed one gets a new random password, so nobody who set one can use it), then have
 * Supabase Auth email the code to the invited address.
 */
export async function sendInviteEmailCode(email: string, fullName: string, returnTo: string): Promise<string | null> {
  if (!adminAvailable()) return "Sign-ins cannot be created on this server yet. Ask Taviron for help.";
  const admin = createAdminClient();
  const created = await admin.auth.admin.createUser({
    email, password: randomPassword(), email_confirm: false, user_metadata: { full_name: fullName }, app_metadata: { [INVITE_PASSWORD_FLAG]: true },
  });
  if (created.error) {
    const existing = created.error.code === "email_exists" ? await findAccount(admin, email) : null;
    if (existing?.confirmed) return "You already have a Taviron sign-in. Reload this page and sign in with it.";
    if (!existing) return "The code could not be sent. Try again in a minute, or ask for a new invitation.";
    const updated = await admin.auth.admin.updateUserById(existing.id, { password: randomPassword(), app_metadata: { [INVITE_PASSWORD_FLAG]: true } });
    if (updated.error) return "The code could not be sent. Try again in a minute, or ask for a new invitation.";
  }
  const sent = await (await createClient()).auth.resend({ type: "signup", email, options: { emailRedirectTo: returnTo } });
  if (sent.error) {
    if (sent.error.status === 429) return CODE_SENT_RECENTLY;
    console.error("Invitation email code failed", { status: sent.error.status, code: sent.error.code });
    return "The code could not be sent. Try again in a minute, or ask for a new invitation.";
  }
  return null;
}

/**
 * Check the emailed code (it confirms the address and signs the person in), then set the password they chose. Wrong
 * codes count like wrong passwords for this email (src/server/signin-limit.ts).
 */
export async function verifyInviteEmailCode(email: string, code: string, password: string): Promise<string | null> {
  if (!adminAvailable()) return "Sign-ins cannot be created on this server yet. Ask Taviron for help.";
  const limitKey = `invite-code:${email}`;
  if (!(await signInAllowed(limitKey))) return SIGNIN_LIMIT_MESSAGE.replace("wrong passwords", "wrong codes").replace(", or reset the password", "");
  const supabase = await createClient();
  const verified = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
  const user = verified.data.user;
  if (verified.error || !user) {
    if (verified.error?.status === 429) return "Too many attempts. Wait a few minutes and try again.";
    await recordSignInFailure(limitKey);
    return "That code is not correct or has expired. Check the newest email, or ask for a new code.";
  }
  if (user.email?.toLowerCase() !== email) {
    await supabase.auth.signOut();
    return "That code is for a different email address.";
  }
  const updated = await createAdminClient().auth.admin.updateUserById(user.id, { password, app_metadata: { [INVITE_PASSWORD_FLAG]: null } });
  if (updated.error) return "Your email is confirmed, but the password could not be saved. Reload the page and choose it again.";
  // Saving a password ends the person's sessions (Supabase Auth): sign in again with the new one.
  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  if (signedIn.error) return "Your email is confirmed and your password saved, but you could not be signed in. Reload the page and sign in.";
  return null;
}

/** Signed in by the emailed link instead of the code: the person still chooses their own password. */
export async function setInvitedPassword(email: string, password: string): Promise<string | null> {
  if (!adminAvailable()) return "Sign-ins cannot be created on this server yet. Ask Taviron for help.";
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user || data.user.email?.toLowerCase() !== email || data.user.app_metadata?.[INVITE_PASSWORD_FLAG] !== true || !data.user.email_confirmed_at) return "Reload the page and try again.";
  const updated = await createAdminClient().auth.admin.updateUserById(data.user.id, { password, app_metadata: { [INVITE_PASSWORD_FLAG]: null } });
  if (updated.error) return "The password could not be saved. Try again.";
  // Saving a password ends the person's sessions (Supabase Auth): sign in again with the new one.
  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  return signedIn.error ? "Your password was saved, but you could not be signed in. Reload the page and sign in." : null;
}

/** Whether the signed-in person still has to choose their password (they confirmed the email by the link). */
export async function needsInvitedPassword(): Promise<boolean> {
  const { data } = await (await createClient()).auth.getUser();
  return data.user?.app_metadata?.[INVITE_PASSWORD_FLAG] === true;
}

/** Sign in from the invitation page with an existing sign-in, for the invited email only (the gate stays closed elsewhere). */
export async function signInForInvite(email: string, password: string): Promise<string | null> {
  if (!(await signInAllowed(email))) return SIGNIN_LIMIT_MESSAGE;
  const { error } = await (await createClient()).auth.signInWithPassword({ email, password });
  if (!error) return null;
  if (error.status === 400 || error.code === "invalid_credentials") {
    await recordSignInFailure(email);
    return "That password is not correct.";
  }
  if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  if (error.code === "user_banned") return "This sign-in is turned off. Ask Taviron for help.";
  console.warn("Invitation sign-in refused", { status: error.status, code: error.code });
  return "Sign-in is temporarily unavailable. Please try again in a minute.";
}
