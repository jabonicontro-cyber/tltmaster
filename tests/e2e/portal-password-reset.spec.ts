import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { unique } from "./helpers";
import { latestMail } from "./mailbox";
import { TOP_LINE_SLUG } from "./users";

// Customer portal self-service password reset (owner 2026-11-17, master plan §12 PR1): a customer invited by email asks
// for a reset on the portal's sign-in page, opens the link from the local mail catcher, chooses a new password, lands
// back in the portal and signs in with it. The answer never says whether an address has a sign-in (an unknown address
// gets the same words and no email), and a username is told to ask the company, with the reason. Fictional records.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";
const CUSTOMER = "Prairie View Landscaping";
const MAILBOX = path.resolve(process.env.MAILBOX_DIR ?? ".dev-stack/mail");

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** Emails the local catcher received for an address since `after` (ms). */
function mailsTo(to: string, after: number): number {
  if (!existsSync(MAILBOX)) return 0;
  return readdirSync(MAILBOX).filter((f) => Number(f.split("-")[0]) >= after)
    .map((f) => JSON.parse(readFileSync(path.join(MAILBOX, f), "utf8")) as { to: string[] })
    .filter((m) => m.to.some((t) => t.toLowerCase() === to.toLowerCase())).length;
}

test.beforeEach(async () => {
  await sql("insert into private.portal_entitlements (company_id, entitled, note) values ($1, true, 'e2e') on conflict (company_id) do update set entitled = true", [TOP_LINE]);
  await sql("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true", [TOP_LINE]);
});

test.afterEach(async () => {
  await sql("update public.portal_accounts set status = 'revoked', revoked_at = now() where company_id = $1 and email like 'e2e-reset-%' and status <> 'revoked'", [TOP_LINE]);
  await sql("update public.portal_settings set enabled = false where company_id = $1", [TOP_LINE]);
  await sql("delete from private.portal_entitlements where company_id = $1", [TOP_LINE]);
});

test("a customer invited by email resets a forgotten password from the portal and signs in with the new one", async ({ browser }) => {
  test.setTimeout(180_000);
  const email = `e2e-reset-${unique()}@cust.example`;
  // An accepted email sign-in for the sample customer (the invitation itself is tested in customer-portal.spec.ts).
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: `Old-${randomUUID()}`, email_confirm: true });
  if (error) throw error;
  const customer = (await sql<{ id: string }>("select id from public.customers where company_id = $1 and name = $2", [TOP_LINE, CUSTOMER]))[0].id;
  await sql("insert into public.portal_accounts (company_id, customer_id, email, user_id, status, accepted_at) values ($1, $2, $3, $4, 'active', now())", [TOP_LINE, customer, email, created.user.id]);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const cust = await ctx.newPage();
  try {
    await cust.goto(`/portal/${TOP_LINE_SLUG}/login`);
    await cust.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(cust.getByRole("heading", { name: "Reset Your Password" })).toBeVisible();

    // A username: no link can be sent, and the page says why.
    await cust.getByLabel("Email").fill("dispatch.desk");
    await cust.getByRole("button", { name: "Email Me a Reset Link" }).click();
    await expect(cust.getByRole("alert").first()).toContainText("A username has no email address");

    // An address without a sign-in here: the same answer as a real one, and nothing is sent.
    const stranger = `e2e-reset-nobody-${unique()}@cust.example`;
    const strangerAt = Date.now() - 1000;
    await cust.getByLabel("Email").fill(stranger);
    await cust.getByRole("button", { name: "Email Me a Reset Link" }).click();
    await expect(cust.getByRole("status")).toContainText(`If ${stranger} has a sign-in for this portal, a link to choose a new password is on its way.`);

    const sentAt = Date.now() - 1000;
    await cust.getByLabel("Email").fill(email.toUpperCase());
    await cust.getByRole("button", { name: "Email Me a Reset Link" }).click();
    await expect(cust.getByRole("status")).toContainText(`If ${email} has a sign-in for this portal, a link to choose a new password is on its way.`);
    const mail = await latestMail(email, sentAt);
    expect(mail.subject).toMatch(/Reset/);
    expect(mailsTo(stranger, strangerAt)).toBe(0);

    await cust.goto(mail.link.replace(/^https?:\/\/[^/]+/, ""));
    await cust.getByLabel("New password", { exact: true }).fill("Portal-Reset-Passw0rd!");
    await cust.getByLabel("Confirm new password").fill("Portal-Reset-Passw0rd!");
    await cust.getByRole("button", { name: "Save password" }).click();
    // Back to the portal it was asked from, signed in.
    await cust.waitForURL(new RegExp(`/portal/${TOP_LINE_SLUG}$`));
    await expect(cust.getByRole("heading", { name: `Welcome, ${CUSTOMER}` })).toBeVisible();

    // The new password works; the account is still a portal account (no company membership).
    await cust.getByRole("button", { name: "Sign out" }).click();
    await cust.waitForURL(new RegExp(`/portal/${TOP_LINE_SLUG}/login`));
    await cust.getByLabel("Email or username").fill(email);
    await cust.getByLabel("Password", { exact: true }).fill("Portal-Reset-Passw0rd!");
    await cust.getByRole("button", { name: "Sign In" }).click();
    await cust.waitForURL(new RegExp(`/portal/${TOP_LINE_SLUG}$`));
    expect((await sql("select 1 from public.company_memberships where user_id = $1", [created.user.id])).length).toBe(0);
  } finally {
    await ctx.close();
  }
});
