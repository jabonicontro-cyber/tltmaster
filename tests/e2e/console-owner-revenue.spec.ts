import { mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { unique } from "./helpers";
import { totp } from "./mfa";
import { PASSWORD } from "./users";

// Platform console PC2 (20261120022300, 20261120022400): an Admin invites a company's first owner from the company page
// (password and code again); the owner's link works once and leads to choosing a password, setting up two-step and
// becoming the owner. Revenue over time (agreed, not collected) for Admins; Support sees neither.
// Screenshots (deviceScaleFactor 2) go to PC2_SHOTS when it is set.
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.PC2_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string, fullPage = false) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage }); };

// Own team members (not the shared platform test account), so another run's setup cannot replace their authenticator.
const SUPPORT = { email: "e2e-pc2-support@tavirontest.example", name: "Sky Support" };
const ADMIN = { email: "e2e-pc2-admin@tavirontest.example", name: "Ada Admin" };
let supportSecret = "";
let adminSecret = "";

async function db<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** A team member made the operator's way, at the given level, with a fresh authenticator each run. Local database only. */
async function ensureStaff(SUPPORT: { email: string; name: string }, level: "admin" | "support"): Promise<string> {
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
  const { data: granted, error: gErr } = await admin.rpc("platform_admin_grant", { p_email: SUPPORT.email, p_note: `e2e pc2 ${level}` });
  if (gErr || !(granted as { ok: boolean }).ok) throw new Error(`grant: ${gErr?.message ?? JSON.stringify(granted)}`);
  await db((c) => c.query("update private.platform_admins set level = $2 where user_id = $1", [id, level]));
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

/** A code for the next 30-second window, so it is never the one just used. */
async function nextWindowCode(page: Page, secret: string): Promise<string> {
  await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
  return totp(secret);
}

/** Password, then a code from the next 30-second window (never the one used to enroll or just before). */
async function signInStaff(page: Page, who: { email: string }, secret: string) {
  await page.goto("/login");
  await page.getByLabel(/^Email/).fill(who.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => u.pathname === "/mfa");
  await page.getByLabel("6-digit code").fill(await nextWindowCode(page, secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((u) => u.pathname !== "/mfa");
}

async function adminPage(browser: Browser, width = 1366) {
  const ctx = await browser.newContext(width < 500 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await signInStaff(page, ADMIN, adminSecret);
  return { ctx, page };
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  supportSecret = await ensureStaff(SUPPORT, "support");
  adminSecret = await ensureStaff(ADMIN, "admin");
});

test("an Admin invites a company's first owner; the link works once and leads to a password, two-step and ownership", async ({ browser }) => {
  test.setTimeout(240_000);
  const company = `Ridgeway Hauling ${unique()} (test)`;
  const owner = { name: "Morgan Ridgeway", email: `owner-${unique()}-${Date.now().toString(36)}@tavirontest.example` };
  const { ctx, page } = await adminPage(browser);

  // A new company from Onboarding has no owner yet; its page offers the invitation.
  await page.goto("/admin/onboarding");
  await page.getByLabel("Company name").fill(company);
  await page.getByRole("button", { name: "Create company" }).click();
  await expect(page.getByText("Company created. Import its records below.")).toBeVisible({ timeout: 60_000 });
  const id = await db(async (c) => (await c.query<{ id: string }>("select id from public.companies where name = $1", [company])).rows[0].id);
  await page.goto(`/admin/companies/${id}`);
  const panel = page.getByRole("region", { name: "Owner" });
  await expect(panel).toContainText(`${company} has no owner yet`);
  const form = panel.getByRole("form", { name: "Invite the owner" });
  await form.getByLabel("Owner's name").fill(owner.name);
  await form.getByLabel("Owner's email").fill(owner.email);
  await form.getByLabel("Your password").fill(PASSWORD);
  // A wrong code changes nothing.
  await form.getByLabel("Your 6-digit code").fill("000000");
  await form.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(/That code is not correct/)).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await shot(page, "01-company-owner-invite-form");
  await form.getByLabel("Your 6-digit code").fill(await nextWindowCode(page, adminSecret));
  await form.getByRole("button", { name: "Send invitation" }).click();
  const issued = page.getByRole("status", { name: "Owner invitation" });
  await expect(issued).toContainText(`Invitation for ${owner.name}, owner of ${company}`);
  await expect(issued).toContainText("It works once and expires");
  const link = (await issued.getByLabel("Invitation link", { exact: true }).textContent())!.trim();
  expect(link).toMatch(/\/join-company\?token=[0-9a-f]{64}$/);
  await expect(panel.getByRole("list", { name: "Owner invitations" })).toContainText("Waiting to accept");
  await shot(page, "02-company-owner-invite-link");
  const path = link.replace(/^https?:\/\/[^/]+/, "");

  // The owner: choose a password, set up an authenticator app, accept.
  const oc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const op = await oc.newPage();
  await op.goto(path);
  await expect(op.getByRole("heading", { name: `Set up ${company}` })).toBeVisible();
  await expect(op.getByText(`${owner.name}, you are invited to be the owner of ${company}`)).toBeVisible();
  await shot(op, "03-join-company-password");
  await op.getByLabel("Choose a password").fill(PASSWORD);
  await op.getByLabel("Type it again").fill(PASSWORD);
  await op.getByRole("button", { name: "Continue" }).click();
  await op.waitForURL((u) => u.pathname === "/mfa");
  await op.getByRole("button", { name: "Set Up Authenticator App" }).click();
  const secret = await op.getByLabel("Or type this key").inputValue();
  await op.getByLabel("6-digit code from the app").fill(totp(secret));
  await op.getByRole("button", { name: "Turn On Two-Step Verification" }).click();
  await op.getByRole("button", { name: "Create Recovery Codes" }).click();
  await op.getByRole("button", { name: "I Saved Them, Continue" }).click();
  await op.waitForURL((u) => u.pathname === "/join-company");
  await expect(op.getByRole("list", { name: "Steps" }).getByRole("listitem").nth(2)).toHaveAttribute("aria-current", "step");
  await shot(op, "04-join-company-accept");
  await op.getByRole("button", { name: "Become the owner" }).click();
  await op.waitForURL((u) => u.pathname !== "/join-company", { timeout: 60_000 });
  const m = await db(async (c) => (await c.query("select m.role, m.active from public.company_memberships m join public.profiles p on p.id = m.user_id where m.company_id = $1 and lower(p.email) = $2", [id, owner.email])).rows);
  expect(m).toEqual([{ role: "owner", active: true }]);

  // The link works once: opened again (signed in or not) it says it was used.
  await op.goto(path);
  await expect(op.getByText("This invitation has already been used.")).toBeVisible();
  const fresh = await browser.newContext();
  const fp = await fresh.newPage();
  await fp.goto(path);
  await expect(fp.getByText("This invitation has already been used.")).toBeVisible();
  await fp.goto(`/join-company?token=${"0".repeat(64)}`);
  await expect(fp.getByText(/This invitation link is not valid/)).toBeVisible();

  // The company page shows the owner and the accepted invitation; no new invitation can be sent.
  await page.reload();
  await expect(panel.getByRole("list", { name: "Owner invitations" })).toContainText("Accepted");
  await expect(panel.getByRole("form", { name: "Invite the owner" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Setup steps" })).toContainText(/Owner login\s*Done/);
  const history = await db(async (c) => (await c.query<{ action: string }>("select action from public.audit_events where company_id = $1 and action like 'member.%' order by occurred_at", [id])).rows.map((r) => r.action));
  expect(history).toEqual(["member.invited", "member.joined"]);
  await Promise.all([ctx.close(), oc.close(), fresh.close()]);
});

test("revenue over time: agreed monthly amounts by month, new and lost customers, renewals; labelled agreed, not collected", async ({ browser }) => {
  test.setTimeout(120_000);
  const tag = unique();
  const names = [`Copperline Aggregates ${tag} (test)`, `Bluestem Haul ${tag} (test)`, `North Fork Gravel ${tag} (test)`, `Prairie Dust Trucking ${tag} (test)`];
  // Live customers made straight in the database (as the lifecycle would leave them), removed again at the end.
  const ids = await db(async (c) => {
    const out: string[] = [];
    for (const n of names) out.push((await c.query<{ id: string }>("select private.create_company($1, $2) id", [n, `pc2-${tag}-${out.length}`])).rows[0].id);
    const live = (i: number, when: string, cents: number, annual = false) => c.query(
      `insert into private.company_lifecycle (company_id, stage, live_at, agreed_monthly_cents, terms, commitment_start, plan_version_id)
       values ($1, 'live', ${when}, $2, $3, ${annual ? `(${when})::date` : "null"}, (select id from private.platform_plan_versions where plan_key = 'growth' order by version desc limit 1))`,
      [out[i], cents, annual ? "annual" : "monthly"]);
    await live(0, "date_trunc('month', now()) - interval '5 months' + interval '3 days'", 74900);
    await live(1, "date_trunc('month', now()) - interval '2 months' + interval '9 days'", 49900);
    await live(2, "date_trunc('month', now()) + interval '12 hours'", 99900);
    await live(3, "now() - interval '1 year' + interval '30 days'", 59900, true);
    return out;
  });
  try {
    const { ctx, page } = await adminPage(browser);
    await page.goto("/admin/revenue");
    await expect(page.getByRole("heading", { name: "Revenue over time", level: 1 })).toBeVisible();
    await expect(page.getByText("Agreed, not collected").first()).toBeVisible();
    await expect(page.getByText(/Taviron has no payment system: nothing here was charged or received/)).toBeVisible();
    const table = page.getByRole("table", { name: "Agreed monthly revenue by month" });
    await expect(table.getByRole("row")).toHaveCount(13);
    await expect(table.getByRole("row").nth(1)).toContainText(names[2]);
    await expect(page.getByRole("list", { name: "This month" })).toContainText(names[2]);
    await expect(page.getByRole("list", { name: "Upcoming renewals" })).toContainText(names[3]);
    await shot(page, "05-revenue-desktop", true);
    await page.getByRole("link", { name: "6 months" }).click();
    await page.waitForURL(/months=6/);
    await expect(table.getByRole("row")).toHaveCount(7);
    await ctx.close();

    const phone = await adminPage(browser, 390);
    await phone.page.goto("/admin/revenue?months=6");
    await expect(phone.page.getByRole("heading", { name: "Revenue over time", level: 1 })).toBeVisible();
    expect(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(phone.page, "06-revenue-phone", true);
    await phone.ctx.close();
  } finally {
    await db((c) => c.query("delete from private.company_lifecycle where company_id = any($1)", [ids]));
  }
});

test("Support sees no owner invitation and no revenue page", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await signInStaff(page, SUPPORT, supportSecret);

  await expect(page.getByRole("navigation", { name: "Platform" }).getByRole("link")).toHaveText(["Company access", "Support inbox", "My visits", "Search"]);
  await page.goto("/admin/revenue");
  await page.waitForURL((u) => u.pathname === "/staff");
  const someCompany = await db(async (c) => (await c.query<{ id: string }>("select id from public.companies where not is_demo and active order by created_at desc limit 1")).rows[0].id);
  await page.goto(`/admin/companies/${someCompany}`);
  await page.waitForURL((u) => u.pathname === "/staff");
  await expect(page.getByRole("button", { name: /Send invitation|Invite/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Revenue/ })).toHaveCount(0);
  await ctx.close();
});
