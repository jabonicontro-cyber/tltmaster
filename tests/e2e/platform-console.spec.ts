import { createClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { signInPlatform, unique } from "./helpers";
import { asUser } from "./db";
import { totp } from "./mfa";
import { PASSWORD, USERS } from "./users";

// Platform console (PC1, 20261120020100 to 20261120020700): the support inbox for both staff levels, company health,
// usage and timeline, console search, audit log filters, lead demo dates and the pipeline, the staff desk on a phone,
// and where the Taviron team lands after signing in.
test.describe.configure({ mode: "serial" });

const SUPPORT = { email: "e2e-console-support@tavirontest.example", name: "Sol Support" };
let supportSecret = "";

/**
 * A Support-level team member, made the operator's way (service role + platform_admin_grant, then the level), with a
 * fresh authenticator each run whose secret the test uses to compute codes. Local test database only.
 */
async function ensureSupportStaff(): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.SUPABASE_SERVICE_ROLE_KEY!, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!/127\.0\.0\.1|localhost/.test(url)) throw new Error("local database only");
  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: existing } = await admin.from("profiles").select("id").eq("email", SUPPORT.email).maybeSingle();
  let id = (existing as { id: string } | null)?.id;
  if (!id) {
    const { data, error } = await admin.auth.admin.createUser({ email: SUPPORT.email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: SUPPORT.name } });
    if (error) throw error;
    id = data.user.id;
  }
  const { data: granted, error: gErr } = await admin.rpc("platform_admin_grant", { p_email: SUPPORT.email, p_note: "e2e console support" });
  if (gErr || !(granted as { ok: boolean }).ok) throw new Error(`grant: ${gErr?.message ?? JSON.stringify(granted)}`);
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try { await db.query("update private.platform_admins set level = 'support' where user_id = $1", [id]); } finally { await db.end(); }
  const { data: old } = await admin.auth.admin.mfa.listFactors({ userId: id });
  for (const f of old?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: id });
  const user = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: sErr } = await user.auth.signInWithPassword({ email: SUPPORT.email, password: PASSWORD });
  if (sErr) throw sErr;
  const { data: f, error: eErr } = await user.auth.mfa.enroll({ factorType: "totp", friendlyName: `e2e ${unique()}` });
  if (eErr) throw eErr;
  const { error: vErr } = await user.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(f.totp.secret) });
  if (vErr) throw vErr;
  return f.totp.secret;
}

/** Password, then a code from the next 30-second window (never the one used to enroll). */
async function signInSupport(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/^Email/).fill(SUPPORT.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname === "/mfa");
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  await page.getByLabel("6-digit code").fill(totp(supportSecret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((u) => u.pathname !== "/mfa");
}

async function supportPage(browser: Browser, width = 1366) {
  const ctx = await browser.newContext(width < 500 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  await signInSupport(page);
  return { ctx, page };
}

const topLineId = () => asUser(USERS.owner.email, async (q) => (await q("select private.current_company_id() as id")).rows[0].id as string);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  supportSecret = await ensureSupportStaff();
});

test("platform Admins land on the Launchpad after signing in, even after opening a demo", async ({ page }) => {
  await signInPlatform(page);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Launchpad", level: 1 })).toBeVisible();
});

test("support inbox: a customer's request is answered by Support from the desk, recorded and seen by the Admin", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const message = `The dispatch board does not show truck ${unique()} today.`;
  await asUser(USERS.dispatcher.email, async (q) => { await q("insert into public.help_support_requests (page, message) values ('/dispatch', $1)", [message]); });

  // Support lands on the desk, which links to the inbox with the count of new requests.
  const { ctx, page: sp } = await supportPage(browser);
  await expect(sp).toHaveURL(/\/staff$/);
  const desk = sp.getByRole("navigation", { name: "Support desk" });
  await expect(desk.getByRole("link", { name: /Support inbox/ })).toContainText(/new request/);
  await desk.getByRole("link", { name: /Support inbox/ }).click();
  await expect(sp.getByRole("heading", { name: "Support inbox", level: 1 })).toBeVisible();
  const item = sp.getByRole("list", { name: "Support requests" }).getByRole("link").filter({ hasText: message });
  await expect(item).toContainText("New");
  await item.click();
  await expect(sp.getByTestId("request-message")).toHaveText(message);
  await expect(sp.getByRole("link", { name: "Go in through Company access" })).toHaveAttribute("href", /\/staff\?q=Top/);

  // Nothing to save is said plainly; then a reply and the status.
  await sp.getByRole("button", { name: "Save" }).click();
  await expect(sp.getByText(/Nothing to save/)).toBeVisible();
  await sp.getByLabel("Status", { exact: true }).selectOption("answered");
  await sp.getByLabel(/A reply for the customer/).check();
  await sp.getByLabel("Note or reply").fill("Your trucks are back on the board: refresh the page.");
  await sp.getByRole("button", { name: "Save" }).click();
  await expect(sp.getByRole("status")).toContainText("Reply recorded. Nothing was emailed");
  const notes = sp.getByRole("list", { name: "Notes and replies" });
  await expect(notes).toContainText("Your trucks are back on the board");
  await expect(notes).toContainText(SUPPORT.name);
  await expect(sp.getByRole("link", { name: "Open the latest reply in your email" })).toHaveAttribute("href", /^mailto:/);

  // My visits and requests opens for Support.
  await sp.goto("/staff/work");
  await expect(sp.getByRole("heading", { name: "My visits and requests", level: 1 })).toBeVisible();
  await ctx.close();

  // The Admin sees it answered, with the reply, and can open the company.
  await signInPlatform(page);
  await page.goto("/admin/support?status=answered");
  const answered = page.getByRole("list", { name: "Support requests" }).getByRole("link").filter({ hasText: message });
  await expect(answered).toContainText("Answered");
  await answered.click();
  await expect(page.getByRole("list", { name: "Notes and replies" })).toContainText("Reply");
  await expect(page.getByRole("link", { name: "Open the company" })).toHaveAttribute("href", /\/admin\/companies\//);
  await page.getByLabel("Status", { exact: true }).selectOption("closed");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toContainText("Status saved.");

  // The audit log, filtered to this kind of action, shows both changes.
  await page.goto("/admin/platform");
  const filters = page.getByRole("form", { name: "Filter the audit log" });
  await filters.getByLabel("What").selectOption("support_request_status");
  await filters.getByRole("button", { name: "Filter" }).click();
  await page.waitForURL((u) => u.search.includes("action=support_request_status"));
  const log = page.getByRole("table", { name: "Audit log" });
  await expect(log.getByRole("row").filter({ hasText: "Marked Closed" }).first()).toBeVisible();
  await expect(log.getByRole("row").filter({ hasText: "Marked Answered" }).first()).toContainText(SUPPORT.name);
  for (const row of await log.getByRole("row").filter({ hasNotText: "When" }).all()) await expect(row).toContainText("Support request status changed");
  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/admin\/platform#audit$/);
});

test("company health, usage and timeline on the company page; security overview on Administration", async ({ page }) => {
  const id = await topLineId();
  await signInPlatform(page);
  await page.goto(`/admin/companies/${id}`);
  await expect(page.getByRole("heading", { name: "Health at a glance" })).toBeVisible();
  await expect(page.getByTestId("health-verdict")).not.toBeEmpty();
  await expect(page.getByText("Last sign-in")).toBeVisible();
  await expect(page.getByRole("table", { name: "Usage by week" }).or(page.getByText("Nothing recorded in the last 8 weeks."))).toBeVisible();
  await expect(page.getByRole("heading", { name: "Customer timeline" })).toBeVisible();
  // Raw action keys never show.
  await expect(page.locator("main")).not.toContainText(/\b(support_entered|onboarding\.generate|testing_lab\.check)\b/);
  await page.goto("/admin/platform");
  await expect(page.getByRole("heading", { name: "Security overview" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Security counts" })).toContainText("Failed sign-ins");
});

test("console search: Admins find companies and leads; Support finds companies and goes to the desk", async ({ page, browser }) => {
  await signInPlatform(page);
  await page.goto("/staff/search?q=Top%20Line");
  const companies = page.getByRole("list", { name: "Companies" });
  await expect(companies.getByRole("link", { name: /Top Line Trucking/ })).toHaveAttribute("href", /\/admin\/companies\//);
  await page.goto("/staff/search?q=x");
  await expect(page.getByRole("alert").filter({ hasText: "Type at least 2 letters." })).toBeVisible();

  const { ctx, page: sp } = await supportPage(browser);
  await sp.getByRole("navigation", { name: "Support desk" }).getByRole("link", { name: /Search/ }).click();
  await sp.getByRole("searchbox", { name: /Search companies/ }).fill("Top Line");
  await sp.getByRole("button", { name: "Search" }).click();
  await expect(sp.getByRole("list", { name: "Companies" }).getByRole("link", { name: /Top Line Trucking/ })).toHaveAttribute("href", "/staff?q=Top%20Line%20Trucking");
  await expect(sp.getByRole("list", { name: "Leads" })).toHaveCount(0);
  await ctx.close();
});

test("Support can go into a company with a reason on a phone; the Admin console stays closed to them", async ({ browser }) => {
  // A customer company still being set up (no owner yet) is open to Support without a grant; a fresh database has only
  // live companies, which wait for their owner.
  const name = `Phone Haul ${unique()} (test)`;
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  await db.query("insert into public.companies (name, slug) values ($1, $2)", [name, name.toLowerCase().replace(/[^a-z0-9]+/g, "-")]);
  await db.end();
  const { ctx, page: sp } = await supportPage(browser, 390);
  await expect(sp).toHaveURL(/\/staff$/);
  const list = sp.getByRole("table", { name: "Customer companies" });
  const reason = list.getByRole("textbox", { name: `What are you helping ${name} with?` });
  await expect(reason).toBeVisible();
  // Scrolled to, the button sits fully on the screen (not off its right edge).
  const goIn = list.getByRole("form", { name: `Go into ${name}` }).getByRole("button", { name: "Go in" });
  await goIn.scrollIntoViewIfNeeded();
  await expect(goIn).toBeInViewport({ ratio: 1 });
  expect(await sp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await sp.goto("/admin/platform");
  await expect(sp).toHaveURL(/\/staff$/);
  await ctx.close();
});

test("a lead's demo date is recorded with readable history and shows in the pipeline", async ({ page }) => {
  const name = `Dana Demo ${unique()}`;
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  const lead = (await db.query<{ id: string }>("insert into private.leads (kind, name, email, company_name, status) values ('demo', $1, $2, 'Dana Hauling (test)', 'contacted') returning id", [name, `dana-${unique()}@test.example`])).rows[0].id;
  await db.end();
  await signInPlatform(page);
  await page.goto(`/admin/leads/${lead}`);
  // Onboarding progress is only offered once a lead is converted.
  await expect(page.getByLabel("Onboarding")).toHaveCount(0);
  await page.getByLabel("Status", { exact: true }).selectOption("demo_scheduled");
  await page.getByLabel("Demo date").fill("2026-12-03");
  await page.getByLabel("Follow up on").fill("2026-12-01");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL((u) => u.search.includes("saved=1"));
  const history = page.locator("#history");
  await expect(history).toContainText("Changed the demo date · none → Dec 3, 2026");
  await expect(history).toContainText("Changed the follow-up date · none → Dec 1, 2026");
  await expect(history).not.toContainText("2026-12-0");
  await page.goto("/admin/leads/pipeline");
  const column = page.getByRole("list", { name: "Lead pipeline" }).getByRole("listitem", { name: /^Demo Scheduled/ });
  await expect(column.getByRole("link", { name: new RegExp(name) })).toContainText("Demo Dec 3, 2026");
});
