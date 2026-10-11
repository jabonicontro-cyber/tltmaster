import { createHash, randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { normalizeAccessCode } from "../../src/lib/early-access";
import { PASSWORD, USERS } from "./users";

// The early-access gate on a production build (run with E2E_GATE=on against a
// server started with EARLY_ACCESS_GATE=on and EARLY_ACCESS_RECHECK_SECONDS=0;
// see docs/SETUP.md → "Automated tests"). Skipped otherwise. Set E2E_PUBLIC_SITE=on
// when that server also has PUBLIC_SITE=on.
test.skip(process.env.E2E_GATE !== "on", "Needs a server with the early-access gate on (E2E_GATE=on).");
test.describe.configure({ mode: "serial" });

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const newCode = () => `TLT-${Array.from({ length: 20 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("").match(/.{5}/g)!.join("-")}`;
async function siteCode(uses = 10) {
  const code = newCode();
  const [{ id }] = await sql<{ id: string }>("select public.early_access_create_code($1, 'Gate e2e (test)', $2, now() + interval '1 day', 'site_access') as id", [createHash("sha256").update(normalizeAccessCode(code)).digest("hex"), uses]);
  return { code, id };
}
const NOT_VALID = "That password isn't valid. Check it and try again, or ask the person who invited you.";
const resetAttempts = () => sql("delete from private.access_attempts where scope = 'site'");

test.beforeAll(resetAttempts);
test.afterAll(async () => {
  await sql("update private.early_access_codes set revoked_at = now(), revoke_reason = 'e2e cleanup' where label = 'Gate e2e (test)' and revoked_at is null");
  await resetAttempts();
});

/** Every way in without early access: pages redirect to the gate; everything else is refused. */
async function expectLocked(request: APIRequestContext) {
  for (const path of ["/login", "/signup", "/forgot-password", "/command-center", "/orders", "/settings", "/driver", "/admin", "/admin/leads", "/pricing/x"]) {
    const r = await request.get(path, { headers: { accept: "text/html" }, maxRedirects: 0 });
    expect(r.status(), path).toBe(307);
    expect(r.headers().location, path).toMatch(/\/early-access/);
  }
  // A server action is a POST to a page: refused even on a public page.
  for (const [method, path] of [["GET", `/tickets/photos/${randomUUID()}`], ["GET", `/quotes/${randomUUID()}/versions/${randomUUID()}/pdf`], ["POST", `/tickets/${randomUUID()}/scans`], ["POST", "/driver/photos"], ["POST", "/login"], ["POST", "/"], ["POST", "/contact"]] as const) {
    const r = await request.fetch(path, { method, headers: { accept: "*/*", "next-action": "x" }, maxRedirects: 0 });
    expect(r.status(), `${method} ${path}`).toBe(401);
    expect(await r.text(), path).not.toMatch(/Command Center|Delivery Tickets|<form/);
  }
}

test("without early access nothing is reachable except the public website, the gate and Auth email links", async ({ request }) => {
  await expectLocked(request);
  // The public website: open to everyone with PUBLIC_SITE=on (pages by GET only, and its
  // form endpoint); otherwise behind the gate like the rest (the default).
  const open = process.env.E2E_PUBLIC_SITE === "on";
  for (const path of ["/", "/platform", "/solutions", "/pricing", "/about", "/contact", "/demo", "/privacy", "/terms"]) {
    const r = await request.get(path, { headers: { accept: "text/html" }, maxRedirects: 0 });
    if (open) {
      expect(r.status(), path).toBe(200);
      expect(await r.text(), path).not.toMatch(/Good to see you|Attention queue|Loads awaiting a ticket|Sign out/); // marketing, not the app
    } else {
      expect(r.status(), path).toBe(307);
      expect(r.headers().location, path).toMatch(/\/early-access/);
    }
  }
  const lead = await request.post("/api/leads", { headers: { "content-type": "application/json" }, data: "not json", maxRedirects: 0 });
  expect(lead.status()).toBe(open ? 400 : 401); // 400: reached the endpoint (unreadable form); 401: the gate
  // The gate page itself, and Supabase Auth email links (one-time tokens), are reachable.
  expect((await request.get("/early-access")).status()).toBe(200);
  const confirm = await request.get("/auth/confirm?token_hash=invalid&type=email", { maxRedirects: 0 });
  expect(confirm.headers().location ?? "").not.toMatch(/early-access/);
  // A forged cookie does not help.
  const forged = await request.get("/login", { headers: { accept: "text/html", cookie: "taviron-access=v1.eyJnIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwieCI6OTk5OTk5OTk5OSwiYyI6OTk5OTk5OTk5OX0.AAAA" }, maxRedirects: 0 });
  expect(forged.status()).toBe(307);
});

test("personal site codes still work on the Early Access page (phone): wrong code refused, right code opens sign-in; sign-in and sign-out still work", async ({ browser }) => {
  const { code } = await siteCode();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("/command-center");
  await expect(page).toHaveURL(/\/early-access\?next=%2Fcommand-center/);
  await expect(page.getByRole("heading", { name: "Taviron is open by invitation." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  await page.getByLabel("Early Access password").fill("TLT-AAAAA-BBBBB-CCCCC-DDDDD");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toHaveText(NOT_VALID);
  await expect(page.getByLabel("Early Access password")).toHaveValue("TLT-AAAAA-BBBBB-CCCCC-DDDDD"); // kept for correction

  await page.getByLabel("Early Access password").fill(code.toLowerCase().replace(/-/g, " ")); // forgiving about case and separators
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fcommand-center/); // on to the normal sign-in, not into the app
  const cookie = (await ctx.cookies()).find((c) => c.name === "taviron-access");
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
  expect(cookie!.value).not.toContain(normalizeAccessCode(code).slice(3, 12));
  expect(page.url()).not.toContain(code);

  // Refresh keeps access; the gate page itself now steps aside.
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/early-access");
  await expect(page).toHaveURL(/\/login/);

  // Normal sign-in still applies (wrong password refused), then works; sign-out returns to sign-in.
  await page.getByLabel("Email").fill(USERS.office.email);
  await page.getByLabel("Password").fill("wrong-password-123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/command-center/);
  await expect(page.getByRole("heading", { name: "Command Center", level: 1 })).toBeVisible();
  // Passing the gate granted nothing: roles still apply.
  await page.goto("/settings?tab=users");
  await expect(page.getByRole("button", { name: "Invite user" })).toHaveCount(0);
  await page.getByRole("banner").getByRole("button").last().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test("a signed-in user keeps working without the gate cookie; revoking the code locks out admitted devices that are not signed in", async ({ browser }) => {
  const { code, id } = await siteCode();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/early-access");
  await page.getByLabel("Early Access password").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/login/);

  // Signed in, the account is the authorization (accounts exist only by invitation or approved sign-up).
  await page.getByLabel("Email").fill(USERS.dispatcher.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/command-center/);
  await ctx.clearCookies({ name: "taviron-access" });
  await page.goto("/dispatch");
  await expect(page.getByRole("heading", { name: "Dispatch" })).toBeVisible();

  // Another admitted (not signed-in) browser loses access as soon as the code is revoked.
  const other = await browser.newContext();
  const op = await other.newPage();
  await op.goto("/early-access");
  await op.getByLabel("Early Access password").fill(code);
  await op.getByRole("button", { name: "Continue" }).click();
  await expect(op).toHaveURL(/\/login/);
  await sql("select public.early_access_revoke_code($1, 'e2e rotation')", [id]);
  await op.goto("/login");
  await expect(op).toHaveURL(/\/early-access/);
  await op.getByLabel("Early Access password").fill(code);
  await op.getByRole("button", { name: "Continue" }).click();
  await expect(op.getByRole("alert")).toHaveText(NOT_VALID); // revoked: the same message as a wrong password
  await other.close();
  await ctx.close();
});

test("no secret or code reaches the browser", async ({ request }) => {
  const { code } = await siteCode();
  const html = await (await request.get("/early-access")).text();
  const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);
  const secret = process.env.E2E_SITE_ACCESS_SECRET ?? "";
  for (const body of [html, ...(await Promise.all(scripts.map(async (s) => (await request.get(s)).text())))]) {
    if (secret) expect(body).not.toContain(secret);
    expect(body).not.toContain(normalizeAccessCode(code).slice(3));
    expect(body).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|SITE_ACCESS_SECRET=/);
  }
});

test("repeated wrong codes are rate limited, even before the right one", async ({ page }) => {
  await resetAttempts();
  const { code } = await siteCode();
  await page.goto("/early-access");
  for (let i = 0; i < 10; i++) {
    await page.getByLabel("Early Access password").fill(newCode());
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  }
  await page.getByLabel("Early Access password").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Too many attempts from this network. Wait 15 minutes and try again.")).toBeVisible();
  await expect(page).toHaveURL(/\/early-access/);
  await resetAttempts();
});

// The shared Early Access password (EARLY_ACCESS_PASSWORD on the test server, given to the
// spec as E2E_EARLY_ACCESS_PASSWORD). It admits a browser to sign-in only, like a code.
const SHARED = process.env.E2E_EARLY_ACCESS_PASSWORD ?? "";

test.describe("shared Early Access password", () => {
  test.skip(!SHARED, "Needs E2E_EARLY_ACCESS_PASSWORD (the server's EARLY_ACCESS_PASSWORD).");
  test.beforeEach(resetAttempts);

  test("on a phone: show/hide, keyboard only, wrong password refused, right one opens sign-in — never the app", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto("/orders");
    await expect(page).toHaveURL(/\/early-access\?next=%2Forders/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    const field = page.getByLabel("Early Access password");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("type", "password");
    await page.keyboard.type(`${SHARED}x`);
    // Show/hide is a real button, reachable by keyboard.
    await page.keyboard.press("Tab");
    const toggle = page.getByRole("button", { name: "Show password" });
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(field).toHaveAttribute("type", "text");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Enter");
    await expect(field).toHaveAttribute("type", "password");
    await field.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(NOT_VALID);
    await expect(field).toHaveAttribute("aria-invalid", "true");
    expect((await ctx.cookies()).find((c) => c.name === "taviron-access")).toBeUndefined();

    await field.fill(SHARED);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Forders/);
    const cookie = (await ctx.cookies()).find((c) => c.name === "taviron-access");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie!.value).not.toContain(SHARED);
    expect(page.url()).not.toContain(encodeURIComponent(SHARED));

    // Past the gate, but not signed in: the app, its pages and its endpoints still refuse.
    for (const path of ["/command-center", "/orders", "/admin", "/settings"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login/);
    }
    const api = await page.request.fetch(`/tickets/${randomUUID()}/scans`, { method: "POST", headers: { accept: "*/*", "next-action": "x" }, maxRedirects: 0 });
    expect(api.status()).toBe(307);
    expect(api.headers().location).toMatch(/\/login/);

    // Sign-in still decides who gets in, and roles still apply.
    await page.goto("/login");
    await page.getByLabel("Email").fill(USERS.office.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/command-center/);
    await page.goto("/settings?tab=users");
    await expect(page.getByRole("button", { name: "Invite user" })).toHaveCount(0);
    await ctx.close();
  });

  test("a tampered cookie is refused; leaving early access ends this device's grant, so a copied cookie stops working too", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/early-access");
    await page.getByLabel("Early Access password").fill(SHARED);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/login/);
    const cookie = (await ctx.cookies()).find((c) => c.name === "taviron-access")!;

    // Tampering: change the expiry inside the signed token.
    const [v, body, sig] = cookie.value.split(".");
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const forged = `${v}.${Buffer.from(JSON.stringify({ ...claims, x: claims.x + 86400 * 365 })).toString("base64url")}.${sig}`;
    const r = await page.request.get("/login", { headers: { accept: "text/html", cookie: `taviron-access=${forged}` }, maxRedirects: 0 });
    expect(r.status()).toBe(307);
    expect(r.headers().location).toMatch(/\/early-access/);

    // Leave from the sign-in page.
    await page.getByRole("button", { name: "Remove early access from this browser" }).click();
    await expect(page).toHaveURL(/\/early-access\?left=1/);
    await expect(page.getByRole("status")).toHaveText("Early access was removed from this browser.");
    // Replaying the old (genuinely signed) cookie no longer works: its grant is revoked.
    const replay = await page.request.get("/login", { headers: { accept: "text/html", cookie: `taviron-access=${cookie.value}` }, maxRedirects: 0 });
    expect(replay.status()).toBe(307);
    expect(replay.headers().location).toMatch(/\/early-access/);
    await ctx.close();
  });

  test("the password is rate limited like codes, and never reaches the browser", async ({ page, request }) => {
    await page.goto("/early-access");
    for (let i = 0; i < 10; i++) {
      await page.getByLabel("Early Access password").fill(`not-the-password-${i}`);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    }
    await page.getByLabel("Early Access password").fill(SHARED);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toHaveText("Too many attempts from this network. Wait 15 minutes and try again.");
    await expect(page).toHaveURL(/\/early-access/);
    await resetAttempts();

    const html = await (await request.get("/early-access")).text();
    const scripts = [...html.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]);
    for (const body of [html, ...(await Promise.all(scripts.map(async (s) => (await request.get(s)).text())))]) {
      expect(body).not.toContain(SHARED);
      expect(body).not.toMatch(/EARLY_ACCESS_PASSWORD/);
    }
  });
});
