import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { randomUUID } from "node:crypto";
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
  await page.getByLabel("6-digit code from the app").fill(totp(secret));
  await page.getByRole("button", { name: "Turn On Two-Step Verification" }).click();
  await page.getByRole("button", { name: "Create Recovery Codes" }).click();
  const list = page.getByRole("list", { name: "Recovery codes" });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  const codes = await list.getByRole("listitem").allTextContents();
  expect(codes).toHaveLength(10);
  await page.getByRole("button", { name: "I Saved Them — Continue" }).click();
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
