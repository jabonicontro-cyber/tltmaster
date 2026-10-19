import { expect, test } from "@playwright/test";
import { signIn, closeDemoWelcomeIfShown, signInPlatform } from "./helpers";
import { PASSWORD, USERS } from "./users";

test("anonymous visitors are sent to sign in, then back to the page they wanted", async ({ page }) => {
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login\?next=%2Fcustomers/);
  await page.getByLabel("Email").fill(USERS.office.email);
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
  // The email is kept after a failed attempt.
  await expect(page.getByLabel("Email")).toHaveValue(USERS.office.email);
});

test("sign in lands on the Command Center and sign out returns to sign in", async ({ page }) => {
  await signIn(page, "office");
  await expect(page).toHaveURL(/\/command-center/);
  await expect(page.getByRole("heading", { name: "Command Center", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /Omar Office/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/command-center");
  await expect(page).toHaveURL(/\/login/);
});

test("private pages are never indexed", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.headers()["x-robots-tag"]).toContain("noindex");
  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toContain("Disallow: /");
});

test("the logo on the sign-in page goes to the public website, in the same tab, by mouse or keyboard", async ({ page }) => {
  // The sandbox cannot reach the real site: answer for it so the navigation itself is checked.
  await page.route("https://mytaviron.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Taviron website</title>" }));
  for (const path of ["/login", "/forgot-password"]) {
    await page.goto(path);
    const logo = page.getByRole("link", { name: "Taviron website" });
    await expect(logo, path).toHaveAttribute("href", "https://mytaviron.com");
    await expect(logo, path).not.toHaveAttribute("target", /.+/);
  }
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeFocused(); // the form starts focused; the logo comes just before it
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("link", { name: "Taviron website" })).toBeFocused();
  const pages = page.context().pages().length;
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("https://mytaviron.com/");
  expect(page.context().pages().length).toBe(pages); // same tab
});

test("after sign-in, a 'next' that a browser would read as another site is ignored", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent("/\t/evil.example")}`);
  await page.getByLabel("Email").fill(USERS.office.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/localhost:\d+\/command-center/);
});

test("an unconfirmed email is named as such after the right password; a wrong password still gets the generic message", async ({ page }) => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  test.skip(!url || !key, "Needs the local Supabase service key.");
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const email = `unconfirmed-${Date.now()}@tavirontest.example`;
  const { error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: false });
  expect(error).toBeNull();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Wrong-Passw0rd-999");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("This email address has not been confirmed yet.", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(/\/login/); // still not signed in
});

test("the platform administration link appears only for platform owners, and /admin still checks the role", async ({ page, browser }) => {
  // A company owner without the platform role: no link, and the area does not exist for them.
  await signIn(page, "owner");
  await page.getByRole("banner").getByRole("button").last().click();
  await expect(page.getByRole("menuitem", { name: /Sign out/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Platform administration" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect((await page.goto("/admin"))?.status()).toBe(404);

  // A platform owner who is working inside a company sees the link, and it opens the portal.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await signInPlatform(p);
  await p.waitForURL((u) => !u.pathname.startsWith("/login"));
  await p.goto("/command-center");
  test.skip(!p.url().includes("/command-center"), "The platform test user has no company here (start the live demo once).");
  await closeDemoWelcomeIfShown(p); // the platform user's current company may be a demo created by another test
  await p.getByRole("banner").getByRole("button").last().click();
  await p.getByRole("menuitem", { name: "Platform administration" }).click();
  await expect(p).toHaveURL(/\/admin$/);
  await expect(p.getByRole("navigation", { name: "Platform" })).toBeVisible();
  await ctx.close();
});
