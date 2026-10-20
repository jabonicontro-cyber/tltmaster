"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { isUsernameEmail } from "@/lib/usernames";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import {
  blockIfUnused, emailSetupLink, issueSetup, loginUrl, NOT_INSTALLED, reissue, reserveAndCreate, suggestUsername, unblock, type IssuedCredential,
} from "@/server/accounts";
import { createClient } from "@/server/supabase/server";

// Customer-portal sign-ins with a username (docs/ACCOUNT_PROVISIONING.md §4). customers.edit creates and manages them;
// every step is checked again by the database, which also keeps each login to one customer of this company. A portal
// login never becomes a company membership, and an employee sign-in never becomes a portal login.

const PATH = "/customer-portal";
const uuid = z.uuid();

async function staff() {
  return assertPermission("customers.edit");
}

async function portalSlug(): Promise<string | undefined> {
  const { data } = await (await createClient()).rpc("portal_admin_state");
  return (data as { slug?: string } | null)?.slug;
}

export async function checkPortalUsername(username: string): Promise<{ valid: boolean; available: boolean } | null> {
  await staff();
  const { data, error } = await (await createClient()).rpc("account_username_available", { p_username: username, p_kind: "portal" });
  if (error) return null;
  return data as { valid: boolean; available: boolean };
}

/** An available username made from the contact's name (staff can still type their own). */
export async function suggestPortalUsername(name: string): Promise<string | null> {
  await staff();
  return suggestUsername("portal", String(name).slice(0, 120));
}

const createSchema = z.object({
  request_key: uuid,
  customer: uuid,
  contact: z.union([uuid, z.literal("")]).default(""),
  contact_name: z.string().trim().max(120).default(""),
  contact_email: z.union([z.email("Enter a valid email or leave it empty."), z.literal("")]).default(""),
  username: z.string().trim().min(3, "Choose a username.").max(32),
});

export interface CreatedPortalSignIn extends IssuedCredential {
  personName: string;
  customerName: string;
  loginUrl: string;
  email: string;
}

export async function createPortalSignIn(formData: FormData): Promise<ActionResult<CreatedPortalSignIn>> {
  const access = await staff();
  if (access.isDemo) return fail("Demo companies do not create sign-ins: preview the portal from the Testing Lab instead.");
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue?.message ?? "Check the form.", issue?.path[0] ? { [String(issue.path[0])]: issue.message } : undefined);
  }
  const p = parsed.data;
  if (!p.contact && p.contact_name.length < 2) return fail("Choose a contact or enter the person's name.", { contact_name: "Enter the person's name." });
  if (p.contact_email && isUsernameEmail(p.contact_email)) return fail("Enter the person's own email, or leave it empty.", { contact_email: "Enter their own email." });
  const supabase = await createClient();

  // Who it is for, read with the caller's own permissions (the database checks the same again).
  const [{ data: customer }, { data: contact }] = await Promise.all([
    supabase.from("customers").select("name").eq("id", p.customer).maybeSingle(),
    p.contact ? supabase.from("customer_contacts").select("name, email, customer_id").eq("id", p.contact).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!customer) return fail("Customer not found.", { customer: "Choose a customer." });
  const c = contact as { name: string; email: string | null; customer_id: string } | null;
  if (p.contact && (!c || c.customer_id !== p.customer)) return fail("Contact not found for this customer.", { contact: "Choose a contact of this customer." });
  const personName = c?.name ?? p.contact_name;

  // The portal must be open and the contact must not have a sign-in already: checked before an Auth user is made.
  const { data: state } = await supabase.rpc("portal_admin_state");
  if (!(state as { open?: boolean } | null)?.open) return fail("Turn the customer portal on (Settings tab) before creating customer sign-ins.");

  const created = await reserveAndCreate("portal", p.request_key, p.username, personName);
  if (!created.ok) return created.error.includes("taken") ? fail(created.error, { username: created.error }) : created;
  const { userId, username, temporaryPassword } = created.data;
  const login = await supabase.rpc("portal_create_login", {
    p_request_key: p.request_key, p_customer: p.customer, p_contact: p.contact || null, p_contact_name: p.contact_name, p_contact_email: p.contact_email,
  });
  if (login.error) return fail(login.error.code === "PGRST202" ? NOT_INSTALLED : dbErrorMessage(login.error));
  const issued = await issueSetup("portal", userId, "print");
  if (!issued.ok) return issued;
  revalidatePath(PATH);
  return ok({
    userId, username, temporaryPassword, expiresAt: issued.data.expiresAt, personName, customerName: (customer as { name: string }).name,
    loginUrl: loginUrl("portal", await portalSlug()), email: c?.email ?? p.contact_email,
  }, "Portal sign-in created.");
}

/** The portal account row of one of this company's username logins (RLS keeps it to the company). */
async function portalAccount(userId: string) {
  const { data } = await (await createClient()).from("portal_accounts").select("id, status, contact_id, customer_id").eq("user_id", userId).maybeSingle();
  return data as { id: string; status: string; contact_id: string | null; customer_id: string } | null;
}

export async function reissuePortalSignIn(userId: string): Promise<ActionResult<IssuedCredential & { loginUrl: string }>> {
  await staff();
  if (!uuid.safeParse(userId).success) return fail("Sign-in not found.");
  const account = await portalAccount(userId);
  if (!account || account.status !== "active") return fail("Turn this sign-in on before issuing a new password.");
  const r = await reissue("portal", userId);
  if (!r.ok) return r;
  revalidatePath(PATH);
  return ok({ ...r.data, loginUrl: loginUrl("portal", await portalSlug()) }, r.message);
}

async function contactOf(userId: string): Promise<{ name: string; email: string }> {
  const account = await portalAccount(userId);
  if (!account?.contact_id) return { name: "there", email: "" };
  const { data } = await (await createClient()).from("customer_contacts").select("name, email").eq("id", account.contact_id).maybeSingle();
  const c = data as { name: string; email: string | null } | null;
  return { name: c?.name ?? "there", email: c?.email && !isUsernameEmail(c.email) ? c.email : "" };
}

export async function emailPortalSetup(userId: string): Promise<ActionResult<{ reference: string | null }>> {
  const access = await staff();
  if (!uuid.safeParse(userId).success) return fail("Sign-in not found.");
  const contact = await contactOf(userId);
  const r = await emailSetupLink("portal", userId, contact.email, { isDemo: Boolean(access.isDemo), personName: contact.name, companyName: access.companyName ?? "Your supplier" });
  revalidatePath(PATH);
  return r;
}

export async function recordPortalHandoff(userId: string, channel: "print" | "copy"): Promise<void> {
  await staff();
  if (!uuid.safeParse(userId).success) return;
  await (await createClient()).rpc("account_delivery_record", { p_user: userId, p_kind: "portal", p_channel: channel, p_outcome: "prepared", p_reference: "" });
}

/**
 * Turn a customer's sign-in off: their portal access ends at once (portal_revoke), and when the sign-in has no access
 * anywhere else it is blocked in Auth so open sessions stop. Requests, messages and history are kept.
 */
export async function turnOffPortalSignIn(userId: string): Promise<ActionResult> {
  await staff();
  if (!uuid.safeParse(userId).success) return fail("Sign-in not found.");
  const account = await portalAccount(userId);
  if (!account) return fail("Sign-in not found.");
  const supabase = await createClient();
  if (account.status !== "revoked") {
    const off = await supabase.rpc("portal_revoke", { p_account: account.id });
    if (off.error) return fail(dbErrorMessage(off.error));
    await supabase.rpc("account_access_record", { p_user: userId, p_kind: "portal", p_action: "revoked" });
  }
  const blocked = await blockIfUnused("portal", userId);
  revalidatePath(PATH);
  return ok(undefined, blocked ? "Sign-in turned off and signed out everywhere. Their requests and history are kept." : "Portal access removed. Their requests and history are kept.");
}

/** Turn a revoked username sign-in back on. It starts over with a new temporary password, returned once. */
export async function turnOnPortalSignIn(userId: string): Promise<ActionResult<IssuedCredential & { loginUrl: string }>> {
  await staff();
  if (!uuid.safeParse(userId).success) return fail("Sign-in not found.");
  const account = await portalAccount(userId);
  if (!account) return fail("Sign-in not found.");
  const supabase = await createClient();
  if (account.status === "revoked") {
    const on = await supabase.rpc("portal_reactivate", { p_account: account.id });
    if (on.error) return fail(on.error.code === "PGRST202" ? NOT_INSTALLED : dbErrorMessage(on.error));
  }
  await unblock("portal", userId);
  const r = await reissue("portal", userId);
  if (!r.ok) return r;
  // No revalidation here: refreshing now would move the row out of the "Turned off" group and unmount the panel that
  // shows the one-time temporary password. The panel refreshes the list when the person clicks Done.
  return ok({ ...r.data, loginUrl: loginUrl("portal", await portalSlug()) }, "Sign-in turned on with a new temporary password.");
}

export async function portalAccountEvents(userId: string): Promise<Array<{ at: string; event: string; method: string | null; channel: string | null }> | string> {
  await staff();
  if (!uuid.safeParse(userId).success) return "Sign-in not found.";
  const { data, error } = await (await createClient()).rpc("account_events", { p_user: userId, p_kind: "portal" });
  if (error) return error.code === "PGRST202" ? NOT_INSTALLED : dbErrorMessage(error);
  return (data ?? []) as Array<{ at: string; event: string; method: string | null; channel: string | null }>;
}
