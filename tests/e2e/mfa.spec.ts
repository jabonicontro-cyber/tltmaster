import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { setUpAuthenticator } from "./helpers";
import { totp } from "./mfa";

// Two-step verification (20261120000900) with a throwaway dispatcher: set up an authenticator, get recovery codes,
// be asked for a code at the next sign-in, refuse a wrong code, and recover with a one-time code. The shared test
// users are not touched.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";
const PASSWORD = `Mfa-${randomUUID()}`;

async function sql(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
}

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let userId = "";
let email = "";

test.beforeEach(async () => {
  email = `e2e-mfa-${randomUUID().slice(0, 8)}@toplinetest.example`;
  const { data, error } = await admin().auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: "Mia Factor" } });
  if (error) throw error;
  userId = data.user.id;
  await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'dispatcher', true)", [TOP_LINE, userId]);
});

test.afterEach(async () => {
  await sql("update public.company_memberships set active = false where user_id = $1", [userId]);
  const { data } = await admin().auth.admin.mfa.listFactors({ userId });
  for (const f of data?.factors ?? []) await admin().auth.admin.mfa.deleteFactor({ id: f.id, userId });
});

async function signInWithPassword(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("set up an authenticator, be asked for it at sign-in, refuse a wrong code, recover with a one-time code", async ({ page }) => {
  test.slow();
  await signInWithPassword(page);
  // Not required for this company: the workspace opens; set up from My profile.
  await page.goto("/profile");
  await page.getByRole("link", { name: "Set Up Two-Step Verification" }).click();
  await page.getByRole("button", { name: "Set Up Authenticator App" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const secret = await page.getByLabel("Or type this key").inputValue();
  expect(secret).toMatch(/^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/);
  await page.getByLabel("6-digit code from the app").fill(totp(secret));
  await page.getByRole("button", { name: "Turn On Two-Step Verification" }).click();
  await page.getByRole("button", { name: "Create Recovery Codes" }).click();
  const list = page.getByRole("list", { name: "Recovery codes" });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  const codes = await list.getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10);
  await expect(page.getByRole("button", { name: "Print Codes" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download (.txt)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("taviron-recovery-codes.txt");
  const { readFile } = await import("node:fs/promises");
  const text = await readFile((await file.path())!, "utf8");
  for (const c of codes) expect(text).toContain(c);
  await page.getByRole("button", { name: "I Saved Them, Continue" }).click();
  await expect(page).toHaveURL(/\/profile/);
  await expect(page.getByText("Two-step on")).toBeVisible();

  // Next sign-in: the password alone opens nothing.
  await page.context().clearCookies();
  await signInWithPassword(page);
  await expect(page).toHaveURL(/\/mfa/);
  await page.goto("/dispatch");
  await expect(page).toHaveURL(/\/mfa/);
  await page.getByLabel("6-digit code").fill(totp(secret, Date.now() - 5 * 60_000));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/That code did not work/)).toBeVisible();
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((u) => u.pathname !== "/mfa");

  // Lost phone: a recovery code removes the authenticator and asks for a new one; the code works once.
  await page.context().clearCookies();
  await signInWithPassword(page);
  await page.getByRole("button", { name: /Use a recovery code/ }).click();
  await page.getByLabel("Recovery code", { exact: true }).fill(codes[0]);
  await page.getByRole("button", { name: "Use Recovery Code" }).click();
  await expect(page).toHaveURL(/\/mfa\?reset=1/);
  await expect(page.getByRole("heading", { name: "Set up two-step verification" })).toBeVisible();
  const events = await sql("select event from private.security_events where user_id = $1 order by at", [userId]);
  expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(["mfa.enrolled", "mfa.challenge_failed", "mfa.verified", "mfa.recovery_used", "mfa.removed"]));
  const used = await sql("select count(*)::int n from private.mfa_recovery_codes where user_id = $1 and used_at is not null", [userId]);
  expect(used[0].n).toBe(1);
});

// Money access always needs two-step verification (20261120018000, owner decision 2026-11-09): an office person is
// asked to set it up at the first sign-in, in plain words, and cannot open the workspace until they do; it cannot be
// turned off. Accounts that belong only to demo companies are exempt.

async function throwawayUser(name: string) {
  const address = `e2e-money-${randomUUID().slice(0, 8)}@toplinetest.example`;
  const { data, error } = await admin().auth.admin.createUser({ email: address, password: PASSWORD, email_confirm: true, user_metadata: { full_name: name } });
  if (error) throw error;
  return { id: data.user.id, email: address };
}

async function passwordOnly(page: import("@playwright/test").Page, address: string) {
  await page.goto("/login");
  await page.getByLabel(/^Email/).fill(address);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

test("an office person is asked to set up two-step verification at first sign-in, and cannot turn it off", async ({ page }) => {
  test.slow();
  const office = await throwawayUser("Olive Ledger");
  await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'office', true)", [TOP_LINE, office.id]);
  try {
    await passwordOnly(page, office.email);
    await expect(page).toHaveURL(/\/mfa/);
    await expect(page.getByRole("heading", { name: "Set up two-step verification" })).toBeVisible();
    // Why, what it is, which app and what comes after, before any step.
    await expect(page.getByText("Your access to invoices, payments or pay requires two-step verification.")).toBeVisible();
    await expect(page.getByText(/Someone who learns your password still cannot get in/)).toBeVisible();
    await expect(page.getByText(/Google Authenticator, Microsoft Authenticator, 1Password or Authy/)).toBeVisible();
    await expect(page.getByRole("list", { name: "Steps" })).toContainText("Save your recovery codes");
    // No phone at hand: what to do, in one line (walkthrough 2026-11-11).
    await expect(page.getByTestId("mfa-no-phone")).toHaveText("No phone with you? Sign out below and come back when you have it. The office cannot skip this step for you.");
    // Nothing in the workspace opens first.
    await page.goto("/billing");
    await expect(page).toHaveURL(/\/mfa/);

    // Recovery codes are required for money access (owner 2026-11-10): no "Later", and leaving before confirming that
    // they were saved opens nothing; the server sends the person back to this step.
    await page.getByRole("button", { name: "Set Up Authenticator App" }).click();
    const secret = await page.getByLabel("Or type this key").inputValue();
    await page.getByLabel("6-digit code from the app").fill(totp(secret));
    await page.getByRole("button", { name: "Turn On Two-Step Verification" }).click();
    await expect(page.getByRole("heading", { name: "One last step: recovery codes" })).toBeVisible();
    await expect(page.getByText("Because your account can see or change money, this step is required before you continue.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Later/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Create Recovery Codes" }).click();
    await expect(page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveCount(10);
    await expect(page.getByRole("button", { name: "I Saved Them, Continue" })).toBeDisabled();
    await page.goto("/billing");
    await expect(page).toHaveURL(/\/mfa/);
    await expect(page.getByRole("heading", { name: "One last step: recovery codes" })).toBeVisible();
    await expect(page.getByText(/were not confirmed as saved\. Create a new set now/)).toBeVisible();
    await page.getByRole("button", { name: "Create Recovery Codes" }).click();
    await expect(page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem")).toHaveCount(10);
    await page.getByLabel("I saved these codes somewhere safe").check();
    await page.getByRole("button", { name: "I Saved Them, Continue" }).click();
    await page.waitForURL((u) => u.pathname !== "/mfa");
    await expect(page).toHaveURL(/\/command-center/);
    await page.goto("/billing");
    await expect(page).toHaveURL(/\/billing/);
    // Required for this person: My profile offers no way to turn it off.
    await page.goto("/profile");
    await expect(page.getByText("Two-step on")).toBeVisible();
    await expect(page.getByText("Your access to invoices, payments or pay requires two-step verification.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Turn Off" })).toHaveCount(0);
  } finally {
    await sql("update public.company_memberships set active = false where user_id = $1", [office.id]);
    const { data } = await admin().auth.admin.mfa.listFactors({ userId: office.id });
    for (const f of data?.factors ?? []) await admin().auth.admin.mfa.deleteFactor({ id: f.id, userId: office.id });
  }
});

test("an owner of a demo company only signs in without an authenticator; money access in a real company changes that", async ({ page }) => {
  const tag = randomUUID().slice(0, 6);
  const demo = (await sql("select private.create_company($1, $2) as id", [`Money Demo ${tag}`, `e2e-money-demo-${tag}`]))[0].id as string;
  await sql("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
  const owner = await throwawayUser("Demi Owner");
  await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [demo, owner.id]);
  await sql("update public.profiles set active_company_id = $1 where id = $2", [demo, owner.id]);
  try {
    await passwordOnly(page, owner.email);
    await expect(page).toHaveURL(/\/command-center/);
    expect(new URL(page.url()).pathname).not.toBe("/mfa");
    // The same login also works in a real company's office: now required everywhere, the demo included.
    await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'office', true)", [TOP_LINE, owner.id]);
    await page.context().clearCookies();
    await passwordOnly(page, owner.email);
    await expect(page).toHaveURL(/\/mfa/);
    await expect(page.getByText("Your access to invoices, payments or pay requires two-step verification.")).toBeVisible();
    // Setting it up (recovery codes confirmed as saved, as money access requires) opens the workspace again.
    await setUpAuthenticator(page);
    expect(new URL(page.url()).pathname).not.toBe("/mfa");
  } finally {
    await sql("update public.company_memberships set active = false where user_id = $1", [owner.id]);
    const { data } = await admin().auth.admin.mfa.listFactors({ userId: owner.id });
    for (const f of data?.factors ?? []) await admin().auth.admin.mfa.deleteFactor({ id: f.id, userId: owner.id });
  }
});
