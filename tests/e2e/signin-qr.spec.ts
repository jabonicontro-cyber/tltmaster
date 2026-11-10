import { createClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";

// Driver sign-in without typing (DS1, migration 20261120017000), end to end on the local stack: the owner opens a driver
// in Fleet and shows a one-time QR code; a phone opening the code's address is signed in as that driver and lands on
// My Day; the office window says so; the same code on another phone is refused; a code whose window was closed is
// refused; a company whose driver role can see money gets no code (SEC4). Face or fingerprint sign-in: this local auth
// server has no passkey API, so its buttons must stay hidden.
// Fictional people only.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** A driver who already chose their password: a username sign-in, a driver membership and the driver record. */
async function driverWithSignIn(name: string) {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const username = `e2e-qr-${unique()}${Math.floor(Math.random() * 1000)}`;
  const { data, error } = await admin.auth.admin.createUser({ email: `${username}@users.mytaviron.com`, password: `Pw-${unique()}-${unique()}!`, email_confirm: true, user_metadata: { full_name: name } });
  if (error || !data.user) throw new Error(`could not create the test sign-in: ${error?.message}`);
  const user = data.user.id;
  await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'driver', true)", [TOP_LINE, user]);
  await sql("update public.profiles set full_name = $2 where id = $1", [user, name]);
  const [driver] = await sql<{ id: string }>("insert into public.drivers (company_id, name, user_id) values ($1, $2, $3) returning id", [TOP_LINE, name, user]);
  return { user, driver: driver.id };
}

// Invented codes are limited per network address (8 in 15 minutes); this test server is reached from 127.0.0.1.
const resetQrLimit = () => sql("delete from private.signin_failures f using unnest($1::text[]) ip where f.login_hash = encode(sha256(convert_to('qr-sign-in:' || ip, 'UTF8')), 'hex')", [["127.0.0.1", "::1", "::ffff:127.0.0.1", "local"]]);
test.beforeAll(resetQrLimit);

// Audit history is append-only, so test sign-ins are kept and turned off; their driver records are made inactive.
test.afterAll(async () => {
  await sql("update public.drivers set active = false where name like 'E2E QR %'");
  await sql("update public.company_memberships set active = false where user_id in (select id from auth.users where email like 'e2e-qr-%@users.mytaviron.com')");
});

/** Show a code from the driver's page; the token is read from the server action's answer (as the QR code holds it). */
async function showCode(page: Page): Promise<string> {
  // The server action's answer is read on its way to the page (the window's status checks post to the same page too,
  // so only the answer that carries a code counts).
  const tokens: string[] = [];
  const pattern = "**/fleet/drivers/**";
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    const m = body.match(/\/auth\/qr#t=([A-Za-z0-9_-]{43})/);
    if (m) tokens.push(m[1]);
    await route.fulfill({ response, body });
  });
  await page.getByTestId("show-sign-in-qr").click();
  await expect(page.getByTestId("sign-in-qr")).toBeVisible();
  await expect.poll(() => tokens.length, { message: "the action returns the code's address" }).toBe(1);
  await page.unroute(pattern);
  return tokens[0];
}

async function phone(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  return { ctx, page: await ctx.newPage() };
}

test("the office shows a QR code; the phone that opens it is signed in once; reuse and closed codes are refused", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const name = `E2E QR Driver ${unique()}`;
  const { driver } = await driverWithSignIn(name);

  await signIn(page, "owner");
  await page.goto(`/fleet/drivers/${driver}`);
  await expect(page.getByRole("heading", { name: "Phone sign-in" })).toBeVisible();
  // This local auth server has no passkey API: nothing about face or fingerprint is shown to the office.
  await expect(page.getByTestId("passkey-summary")).toHaveCount(0);
  const token = await showCode(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Sign ${name} in on their phone` })).toBeVisible();
  await expect(dialog.getByTestId("qr-status")).toContainText("Waiting for the phone");
  await expect(dialog.getByText(/Only show this code to the driver/)).toBeVisible();

  // The driver's phone opens the code's address: signed in as the driver, on My Day, with the token gone from the address.
  const one = await phone(browser);
  await one.page.goto(`/auth/qr#t=${token}`);
  await one.page.waitForURL(/\/driver$/, { timeout: 60_000 });
  await expect(one.page.getByTestId("greeting")).toBeVisible();
  await expect(one.page.getByRole("heading", { name: "My Day" })).toBeVisible();
  expect(one.page.url()).not.toContain(token);
  // No face or fingerprint offer without the server's passkey API.
  await expect(one.page.getByTestId("passkey-offer")).toHaveCount(0);

  // The office window learns the phone is signed in.
  await expect(dialog.getByText("Signed in on the phone. You can close this window.")).toBeVisible({ timeout: 20_000 });

  // The same code on another phone: refused, and that phone is not signed in.
  const two = await phone(browser);
  await two.page.goto(`/auth/qr#t=${token}`);
  await expect(two.page.getByTestId("qr-refused")).toContainText("already used");
  await two.page.goto("/driver");
  await expect(two.page).toHaveURL(/\/login/);

  // A new code whose window is closed stops working at once.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  const closed = await showCode(page);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await two.page.goto(`/auth/qr#t=${closed}`);
  await expect(two.page.getByTestId("qr-refused")).toContainText("replaced or cancelled");

  // An invented code is refused without saying anything about anyone.
  // (A new page: changing only the fragment of an open page does not load it again.)
  const fresh = await two.ctx.newPage();
  await fresh.goto(`/auth/qr#t=${"A".repeat(43)}`);
  await expect(fresh.getByTestId("qr-refused")).toContainText("not valid");

  // The driver's security history (People) lists the codes, without any secret.
  const [{ n }] = await sql<{ n: number }>("select count(*)::int n from public.audit_events where action in ('account.qr_issued', 'account.qr_used', 'account.qr_refused', 'account.qr_cancelled') and entity_id = (select user_id from public.drivers where id = $1)", [driver]);
  expect(n).toBeGreaterThanOrEqual(5);
  await one.ctx.close();
  await two.ctx.close();
});

test("only people who manage sign-ins see the QR code; the sign-in page has no face or fingerprint button without passkeys", async ({ page, browser }) => {
  const name = `E2E QR Other ${unique()}`;
  const { driver } = await driverWithSignIn(name);
  await signIn(page, "dispatcher");
  await page.goto(`/fleet/drivers/${driver}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByTestId("show-sign-in-qr")).toHaveCount(0);

  const p = await phone(browser);
  await p.page.goto("/login");
  await expect(p.page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(p.page.getByTestId("passkey-sign-in")).toHaveCount(0);
  await p.ctx.close();
});

test("in a demo company the code is a labelled sample: nothing is stored and nothing can sign in", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = unique();
  const [{ id: company }] = await sql<{ id: string }>("select private.create_company($1, $2) as id", [`QR Demo ${tag}`, `prospect-qr${tag}`]);
  await sql("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [company]);
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `e2e-qr-demo-${tag}@demotest.example`;
  const password = `Pw-${unique()}-${unique()}!`;
  const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "QR Demo Owner" } });
  await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [company, data.user!.id]);
  await sql("update public.profiles set active_company_id = $1 where id = $2", [company, data.user!.id]);
  const [{ id: driver }] = await sql<{ id: string }>("insert into public.drivers (company_id, name) values ($1, 'Riley Sample (demo)') returning id", [company]);

  await page.goto("/login");
  await page.getByLabel("Email or username").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.goto(`/fleet/drivers/${driver}`);
  const welcome = page.getByRole("dialog", { name: "Welcome to the Taviron demo" });
  if (await welcome.isVisible().catch(() => false)) await welcome.getByRole("button", { name: "Explore the demo" }).click();
  await page.getByTestId("show-sign-in-qr").click();
  const dialog = page.getByRole("dialog", { name: /Sign Riley Sample \(demo\) in on their phone/ });
  await expect(dialog.getByTestId("qr-demo")).toContainText("this sample code signs nothing in");
  await expect(dialog.getByTestId("sign-in-qr")).toBeVisible();
  const [{ n }] = await sql<{ n: number }>("select count(*)::int n from private.signin_qr_codes where company_id = $1", [company]);
  expect(n).toBe(0);
  await sql("update public.company_memberships set active = false where company_id = $1", [company]);
});

test("a company whose driver role can see money gets no QR code: the page says why (SEC4)", async ({ page }) => {
  test.setTimeout(120_000);
  // A company of its own, so the shared test company's roles never change under other tests.
  const tag = unique();
  const [{ id: company }] = await sql<{ id: string }>("select private.create_company($1, $2) as id", [`QR Money ${tag}`, `qr-money-${tag}`]);
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `e2e-qr-money-${tag}@moneytest.example`;
  const password = `Pw-${unique()}-${unique()}!`;
  const { data } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "QR Money Owner" } });
  const owner = data.user!.id;
  await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'owner', true)", [company, owner]);
  await sql("update public.profiles set active_company_id = $1 where id = $2", [company, owner]);
  const username = `e2e-qr-${tag}m${Math.floor(Math.random() * 1000)}`;
  const d = await admin.auth.admin.createUser({ email: `${username}@users.mytaviron.com`, password: `Pw-${unique()}-${unique()}!`, email_confirm: true });
  await sql("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'driver', true)", [company, d.data.user!.id]);
  const [{ id: driver }] = await sql<{ id: string }>("insert into public.drivers (company_id, name, user_id) values ($1, 'E2E QR Money Driver', $2) returning id", [company, d.data.user!.id]);
  try {
    await sql("insert into public.role_permissions (company_id, role, permission) values ($1, 'driver', 'billing.view') on conflict do nothing", [company]);
    await page.goto("/login");
    await page.getByLabel("Email or username").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    await page.goto(`/fleet/drivers/${driver}`);
    await expect(page.getByTestId("qr-money-refused")).toContainText("can see or change money");
    await expect(page.getByTestId("show-sign-in-qr")).toHaveCount(0);
    // Without the money permission the code is offered again.
    await sql("delete from public.role_permissions where company_id = $1 and role = 'driver' and permission = 'billing.view'", [company]);
    await page.reload();
    await expect(page.getByTestId("show-sign-in-qr")).toBeVisible();
    await expect(page.getByTestId("qr-money-refused")).toHaveCount(0);
  } finally {
    await sql("update public.company_memberships set active = false where company_id = $1", [company]);
  }
});

test("invented codes are limited per network address; other sites cannot post codes", async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const post = (token: string, from = origin) => request.post("/auth/qr/redeem", { headers: { origin: from, "content-type": "application/json" }, data: { token } });
  const invented = () => post(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"));
  await resetQrLimit();
  expect((await post("A".repeat(43), "https://evil.example")).status()).toBe(403);
  expect((await post("not a token")).status()).toBe(400);
  for (let i = 0; i < 7; i++) expect((await invented()).status(), `try ${i + 2}`).toBe(400);
  const limited = await invented();
  expect(limited.status()).toBe(429);
  expect(await limited.json()).toEqual({ ok: false, reason: "limited" });
  await resetQrLimit();
});
