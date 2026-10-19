import "server-only";
import { generateTemporaryPassword } from "@/lib/accounts";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { displayLogin, usernameEmail } from "@/lib/usernames";
import { dbErrorMessage } from "@/server/errors";
import { env } from "@/server/env";
import { getEmailMode } from "@/server/email/provider";
import { adminAvailable, createAdminClient } from "@/server/supabase/admin";
import { createClient } from "@/server/supabase/server";

// Account provisioning (docs/ACCOUNT_PROVISIONING.md; migration 20261120001200). The Auth admin key is used only here,
// on the server, and only after the database confirmed the caller may act (every step below calls a permission-checked
// database function with the caller's own session first). Temporary passwords live only in the returned value.

export type AccountKind = "employee" | "portal";

export interface IssuedCredential {
  userId: string;
  username: string;
  /** Shown once to the administrator who issued it; never stored or logged. */
  temporaryPassword: string;
  expiresAt: string;
}

const MISSING = new Set(["PGRST202", "42883", "42P01"]);
export const NOT_INSTALLED = "Username sign-ins need the database update 20261120001200, which is not installed yet.";
const NO_ADMIN = "Creating sign-ins needs SUPABASE_SERVICE_ROLE_KEY on the server. Ask the Taviron team to configure it.";
/** Print/copy credentials last a week; an emailed link is short-lived (the provider's own link expiry applies too). */
export const PRINT_HOURS = 168;
const EMAIL_HOURS = 24;

export function loginUrl(kind: AccountKind, slug?: string): string {
  const base = env().APP_BASE_URL;
  return kind === "portal" && slug ? `${base}/portal/${slug}/login` : `${base}/login`;
}

function dbFail(error: { code?: string; message: string }) {
  return fail(MISSING.has(error.code ?? "") ? NOT_INSTALLED : dbErrorMessage(error));
}

/** Sign-out everywhere is not available per user in the Auth admin API; a ban stops every refresh. */
const BLOCK = "876000h";

/**
 * Steps 1–2 of a new sign-in: reserve the username (idempotent per request key) and make sure its Auth user exists,
 * with a fresh temporary password. Retrying with the same request key resumes and never creates a second account.
 */
export async function reserveAndCreate(kind: AccountKind, requestKey: string, username: string, fullName: string): Promise<ActionResult<{ userId: string; username: string; temporaryPassword: string }>> {
  if (!adminAvailable()) return fail(NO_ADMIN);
  const supabase = await createClient();
  const begin = await supabase.rpc("account_provision_begin", { p_request_key: requestKey, p_kind: kind, p_username: username });
  if (begin.error) return dbFail(begin.error);
  const r = begin.data as { username: string; address: string; user_id: string | null; setup?: string | null };
  // A repeated request after the person already chose their password: never reset it from here (use Reissue).
  if (r.setup === "complete") return fail("This sign-in was already set up by its owner. Use Reissue on their page if they need a new one.");
  const admin = createAdminClient();
  const temporaryPassword = generateTemporaryPassword();
  let userId = r.user_id;
  if (!userId) {
    const created = await admin.auth.admin.createUser({ email: r.address, password: temporaryPassword, email_confirm: true, user_metadata: { full_name: fullName } });
    if (created.error || !created.data.user) {
      console.warn("Sign-in creation failed", { kind, status: created.error?.status, code: created.error?.code });
      return fail("The sign-in could not be created. Try again in a moment.");
    }
    userId = created.data.user.id;
    const attach = await supabase.rpc("account_provision_attach", { p_request_key: requestKey, p_user: userId });
    if (attach.error) return dbFail(attach.error);
  } else {
    // A retry: the account was made by this request; give it a new temporary password (the first one was never shown).
    const upd = await admin.auth.admin.updateUserById(userId, { password: temporaryPassword });
    if (upd.error) return fail("The sign-in could not be updated. Try again in a moment.");
  }
  return ok({ userId, username: r.username, temporaryPassword });
}

/** Step 4: record that setup is required (fingerprint of the password just set, expiry, method). */
export async function issueSetup(kind: AccountKind, userId: string, method: "print" | "copy" | "email" | "reset", hours = PRINT_HOURS): Promise<ActionResult<{ expiresAt: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("account_setup_issue", { p_user: userId, p_kind: kind, p_hours: hours, p_method: method });
  if (error) return dbFail(error);
  return ok({ expiresAt: (data as { expires_at: string }).expires_at });
}

/**
 * Reissue: a new temporary password replaces the old one (which stops working at once) and setup starts again. The
 * database checks first that this company may do it (its own username sign-in, no access elsewhere, owners for owners).
 */
export async function reissue(kind: AccountKind, userId: string): Promise<ActionResult<IssuedCredential>> {
  if (!adminAvailable()) return fail(NO_ADMIN);
  const supabase = await createClient();
  const check = await supabase.rpc("account_setup_check", { p_user: userId, p_kind: kind });
  if (check.error) return dbFail(check.error);
  const temporaryPassword = generateTemporaryPassword();
  const admin = createAdminClient();
  const upd = await admin.auth.admin.updateUserById(userId, { password: temporaryPassword });
  if (upd.error || !upd.data.user) return fail("The sign-in could not be reset. Try again in a moment.");
  const issued = await issueSetup(kind, userId, "reset");
  if (!issued.ok) return issued;
  return ok({ userId, username: displayLogin(upd.data.user.email), temporaryPassword, expiresAt: issued.data.expiresAt }, "New temporary password issued. The previous one no longer works.");
}

export type EmailAvailability = { available: true } | { available: false; reason: string };

/** Can this server send setup links at all (before knowing the address)? */
export function emailServerStatus(isDemo: boolean): { configured: boolean; reason?: string } {
  if (isDemo) return { configured: false, reason: "Demo companies never send email." };
  const mode = getEmailMode();
  if (mode.mode === "preview") return { configured: false, reason: "Email sending is not set up on this server. Print or copy the instructions instead." };
  if (!adminAvailable()) return { configured: false, reason: NO_ADMIN };
  return { configured: true };
}

export function emailAvailability(isDemo: boolean, to: string | null | undefined): EmailAvailability {
  if (isDemo) return { available: false, reason: "Demo companies never send email." };
  const mode = getEmailMode();
  if (mode.mode === "preview") return { available: false, reason: "Email sending is not set up on this server. Print or copy the instructions instead." };
  if (!to) return { available: false, reason: "Add an email address for this person first." };
  if (mode.mode === "test" && to.toLowerCase() !== mode.testRecipient.toLowerCase()) {
    return { available: false, reason: `Email test mode is on: messages may only go to the test inbox (${mode.testRecipient}).` };
  }
  if (!adminAvailable()) return { available: false, reason: NO_ADMIN };
  return { available: true };
}

/**
 * Email a one-time setup link (never a password) through the configured provider. The link signs the person in once
 * and takes them to "Create your password"; any earlier temporary password is replaced. The result says only what the
 * provider confirmed: accepted for delivery (with its message id), or the failure.
 */
export async function emailSetupLink(kind: AccountKind, userId: string, to: string, ctx: { isDemo: boolean; personName: string; companyName: string }): Promise<ActionResult<{ reference: string | null }>> {
  const avail = emailAvailability(ctx.isDemo, to);
  if (!avail.available) return fail(avail.reason);
  const supabase = await createClient();
  const check = await supabase.rpc("account_setup_check", { p_user: userId, p_kind: kind });
  if (check.error) return dbFail(check.error);
  const admin = createAdminClient();
  const user = await admin.auth.admin.getUserById(userId);
  const address = user.data.user?.email;
  if (!address) return fail("The sign-in was not found.");
  // A fresh unknown password first, so an earlier printed sheet stops working; the link replaces it with theirs.
  const upd = await admin.auth.admin.updateUserById(userId, { password: generateTemporaryPassword() });
  if (upd.error) return fail("The sign-in could not be prepared. Try again in a moment.");
  const link = await admin.auth.admin.generateLink({ type: "recovery", email: address });
  const hashed = link.data?.properties?.hashed_token;
  if (link.error || !hashed) return fail("The setup link could not be created. Try again in a moment.");
  const issued = await issueSetup(kind, userId, "email", EMAIL_HOURS);
  if (!issued.ok) return issued;
  const url = `${env().APP_BASE_URL}/auth/confirm?token_hash=${encodeURIComponent(hashed)}&type=recovery&next=/welcome`;
  const username = displayLogin(address);
  const mode = getEmailMode();
  if (mode.mode === "preview") return fail("Email sending is not set up on this server.");
  const sent = await mode.provider.send(
    {
      to: [to],
      cc: [],
      subject: `${ctx.companyName}: set up your ${kind === "portal" ? "customer portal" : "Taviron"} sign-in`,
      text: [
        `Hello ${ctx.personName},`,
        "",
        `${ctx.companyName} created a ${kind === "portal" ? "customer portal" : "Taviron"} sign-in for you.`,
        `Your username: ${username}`,
        "",
        "Open this link to choose your password (it works once and expires soon):",
        url,
        "",
        `If the link has expired, ask ${ctx.companyName} to send a new one. If you did not expect this email, ignore it.`,
      ].join("\n"),
      attachments: [],
    },
    { idempotencyKey: `account-setup-${userId}-${issued.data.expiresAt}` },
  );
  const record = (outcome: "accepted" | "failed", reference: string) =>
    supabase.rpc("account_delivery_record", { p_user: userId, p_kind: kind, p_channel: "email", p_outcome: outcome, p_reference: reference });
  if (!sent.ok) {
    await record("failed", sent.retryable ? "retryable" : "rejected");
    return fail(`The email was not sent: ${sent.error} Print or copy the instructions instead.`);
  }
  await record("accepted", sent.providerMessageId ?? "");
  return ok({ reference: sent.providerMessageId }, `Accepted for delivery by the email service${sent.providerMessageId ? ` (reference ${sent.providerMessageId})` : ""}. Delivery to the inbox is not confirmed here.`);
}

/** After access was removed here: block the sign-in in Auth when it has no access anywhere else (sessions stop). */
export async function blockIfUnused(kind: AccountKind, userId: string): Promise<boolean> {
  if (!adminAvailable()) return false;
  const supabase = await createClient();
  const { data } = await supabase.rpc("account_block_allowed", { p_user: userId, p_kind: kind });
  if (data !== true) return false;
  const res = await createAdminClient().auth.admin.updateUserById(userId, { ban_duration: BLOCK });
  if (res.error) return false;
  await supabase.rpc("account_access_record", { p_user: userId, p_kind: kind, p_action: "sessions_blocked" });
  return true;
}

export async function unblock(kind: AccountKind, userId: string): Promise<void> {
  if (!adminAvailable()) return;
  const res = await createAdminClient().auth.admin.updateUserById(userId, { ban_duration: "none" });
  if (!res.error) await (await createClient()).rpc("account_access_record", { p_user: userId, p_kind: kind, p_action: "sessions_unblocked" });
}

export interface AccountState {
  user_id: string;
  username: string;
  status: "setup_required" | "complete";
  expired: boolean;
  issued_at: string;
  expires_at: string;
  issue_count: number;
  completed_at: string | null;
  last_sign_in_at: string | null;
  banned: boolean;
}

/** Username sign-ins of the company (null before the migration). */
export async function accountStates(kind: AccountKind): Promise<Map<string, AccountState> | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("company_account_states", { p_kind: kind });
  if (error) return null;
  return new Map(((data ?? []) as AccountState[]).map((s) => [s.user_id, s]));
}

export function usernameAddress(username: string): string {
  return usernameEmail(username);
}
