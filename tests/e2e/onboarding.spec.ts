import { createHash, randomInt } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { normalizeAccessCode } from "../../src/lib/early-access";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

const MAILBOX = path.resolve(".dev-stack/mail");
const TOP_LINE = "00000000-0000-4000-8000-000000000001";

/** The newest email the local mail catcher received for an address (waits up to 10 s). */
async function latestMail(to: string, after: number): Promise<{ subject: string; link: string }> {
  for (let i = 0; i < 40; i++) {
    if (existsSync(MAILBOX)) {
      const files = readdirSync(MAILBOX).filter((f) => Number(f.split("-")[0]) >= after).sort().reverse();
      for (const f of files) {
        const m = JSON.parse(readFileSync(path.join(MAILBOX, f), "utf8")) as { to: string[]; subject: string; body: string };
        if (m.to.some((t) => t.toLowerCase() === to.toLowerCase())) {
          const link = (m.body.match(/href="([^"]+)"/) ?? [])[1]?.replace(/&amp;/g, "&");
          if (link) return { subject: m.subject, link };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No email for ${to}. Is the dev mailbox running (scripts/dev-stack/stack.sh up)?`);
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** An operator-issued code (as scripts/early-access.mjs does), stored as a hash. */
async function issueCode(uses = 1) {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const raw = Array.from({ length: 20 }, () => alphabet[randomInt(32)]).join("");
  const code = `TLT-${raw.match(/.{1,5}/g)!.join("-")}`;
  await sql("select public.early_access_create_code($1, 'E2E onboarding', $2, now() + interval '1 day')", [createHash("sha256").update(normalizeAccessCode(code)).digest("hex"), uses]);
  return code;
}

async function signInAs(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a new customer signs up with an access code, verifies the email, creates a company and invites the team", async ({ page }) => {
  const id = unique();
  const email = `owner-${id}@onboarding.test`;
  const password = `Owner-${id}-Passw0rd`;
  const company = `Ridgeway Aggregates ${id} (test)`;
  const code = await issueCode();

  // Without a valid code nothing is created.
  await page.goto("/signup");
  const fill = async (accessCode: string) => {
    await page.getByLabel("Access code").fill(accessCode);
    await page.getByLabel("Company name").fill(company);
    await page.getByLabel("Your name").fill(`Olivia Owner ${id}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
  };
  await fill("TLT-AAAAA-BBBBB-CCCCC-DDDDD");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("This access code is not valid.").first()).toBeVisible();
  expect(await sql("select 1 from public.profiles where email = $1", [email])).toHaveLength(0);

  const started = Date.now();
  await page.getByLabel("Access code").fill(code.toLowerCase()); // codes are forgiving about case
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");

  // The same code cannot be used twice (one use).
  await page.goto("/signup");
  await fill(code);
  await page.getByLabel("Email").fill(`other-${id}@onboarding.test`);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("This access code has already been used.").first()).toBeVisible();

  // Unverified accounts cannot sign in.
  await signInAs(page, email, password);
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();

  // The verification email (sent by Supabase Auth to the dev mailbox) signs the person in and opens onboarding.
  const mail = await latestMail(email, started);
  expect(mail.subject).toBe("Confirm your email");
  await page.goto(mail.link);
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByLabel("Company name")).toHaveValue(company);
  await page.getByRole("button", { name: "Create my company" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("banner")).toContainText(company);
  const companyId = (await sql<{ id: string }>("select id from public.companies where name = $1", [company]))[0].id;
  expect(await sql("select role from public.company_memberships where company_id = $1", [companyId])).toEqual([{ role: "owner" }]);

  // Invite a brand-new office user and an existing account (Top Line's dispatcher).
  await page.goto("/settings?tab=users");
  const invite = async (to: string, name: string, role: string) => {
    await page.getByRole("button", { name: "Invite user" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Email").fill(to);
    await d.getByLabel("Name").fill(name);
    await d.getByLabel("Role").selectOption(role);
    await d.getByRole("button", { name: "Send invitation" }).click();
  };
  const officeEmail = `office-${id}@onboarding.test`;
  const invitedAt = Date.now();
  await invite(officeEmail, `Owen Office ${id}`, "office");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: `Invitation sent to ${officeEmail}.` })).toBeVisible();
  await invite(USERS.dispatcher.email, "Dana Dispatch", "dispatcher");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "already has an account and was added to your company" })).toBeVisible();
  await invite(USERS.dispatcher.email, "Dana Dispatch", "dispatcher"); // repeated: nothing duplicated
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "is already a member of your company" })).toBeVisible();

  // The new office user accepts the invitation and sets a password.
  await page.context().clearCookies();
  const inviteMail = await latestMail(officeEmail, invitedAt);
  await page.goto(inviteMail.link);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill(`Office-${id}-Passw0rd`);
  await page.getByLabel("Confirm new password").fill(`Office-${id}-Passw0rd`);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("banner")).toContainText(`Office staff · ${company}`);

  // Top Line's dispatcher now has two companies and switches between them; data never mixes.
  await page.context().clearCookies();
  const tlOrder = (await sql<{ id: string }>("select id from public.orders where company_id = $1 limit 1", [TOP_LINE]))[0].id;
  try {
    await signIn(page, "dispatcher");
    await page.getByRole("banner").getByRole("button").last().click();
    await page.getByRole("menuitem", { name: `Switch to ${company}` }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("banner")).toContainText(`Dispatcher · ${company}`);
    await page.goto(`/orders/${tlOrder}`);
    await expect(page.getByText("Not found", { exact: true })).toBeVisible(); // Top Line's order, by URL
    await page.getByRole("banner").getByRole("button").last().click();
    await page.getByRole("menuitem", { name: /Switch to Top Line/ }).click();
    await expect(page.getByRole("banner")).toContainText("Dispatcher · Top Line");
    await page.goto(`/orders/${tlOrder}`);
    await expect(page.getByText("Not found", { exact: true })).toHaveCount(0);
  } finally {
    // Leave the shared e2e dispatcher as it was.
    await sql("delete from public.company_memberships where company_id = $1 and user_id = (select id from public.profiles where email = $2)", [companyId, USERS.dispatcher.email]);
    await sql("update public.profiles set active_company_id = null where email = $1", [USERS.dispatcher.email]);
  }
});

test("signed-out visitors cannot reach onboarding, and the public Auth sign-up stays closed", async ({ page, request }) => {
  // The sign-up page is prerendered: its repeat-submit key is made in each browser, never in the shared HTML.
  const html = await (await request.get("/signup")).text();
  expect(html).toMatch(/name="requestKey" value=""/);
  await page.goto("/onboarding");
  await expect(page).toHaveURL(/\/login\?next=%2Fonboarding/);
  const res = await request.post(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/signup`, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "" },
    data: { email: `public-${unique()}@onboarding.test`, password: "Public-Passw0rd-123" },
  });
  expect(res.status()).toBe(422);
  expect(await res.text()).toContain("signup_disabled");
});
