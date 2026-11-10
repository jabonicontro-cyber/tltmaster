import { expect, type Page } from "@playwright/test";
import { PASSWORD, PLATFORM_USER, USERS, type UserKey } from "./users";
import { platformTotpSecret, totp, userTotpSecret } from "./mfa";

/**
 * Sign in as a shared test user like a person does: the password, then (for anyone the database requires it of, such as
 * owners and office staff with money access, 20261120018000) the code from their authenticator app.
 */
export async function signIn(page: Page, who: UserKey) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS[who].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await passSecondFactor(page, who);
}

/**
 * After the password: when this test user has an authenticator (global-setup enrolled one because the database requires
 * it), wait for the code page and enter the current code, as the person would from their phone.
 */
export async function passSecondFactor(page: Page, who: UserKey) {
  const secret = userTotpSecret(who);
  if (!secret) return;
  // The landing page sends the session to the code page first (redirects can pass through it).
  await page.waitForURL((u) => u.pathname === "/mfa");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((u) => u.pathname !== "/mfa");
}

/**
 * First-time setup on the two-step verification page, the way a new person does it: start the setup, add the key to
 * the "app" (computed here), confirm with its code, create recovery codes, confirm they were saved where the page asks
 * for it (money access), and continue. Returns the secret and codes.
 */
export async function setUpAuthenticator(page: Page): Promise<{ secret: string; codes: string[] }> {
  await expect(page).toHaveURL(/\/mfa/);
  await expect(page.getByRole("heading", { name: "Set up two-step verification" })).toBeVisible();
  await page.getByRole("button", { name: "Set Up Authenticator App" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const secret = await page.getByLabel("Or type this key").inputValue();
  await page.getByLabel("6-digit code from the app").fill(totp(secret));
  await page.getByRole("button", { name: "Turn On Two-Step Verification" }).click();
  await page.getByRole("button", { name: "Create Recovery Codes" }).click();
  const list = page.getByRole("list", { name: "Recovery codes" });
  await expect(list.getByRole("listitem")).toHaveCount(10);
  const codes = await list.getByRole("listitem").allTextContents();
  // Money access (owner 2026-11-10): the person must tick that they saved the codes; continuing waits for it.
  const saved = page.getByLabel("I saved these codes somewhere safe");
  if (await saved.count()) {
    await expect(page.getByRole("button", { name: "I Saved Them, Continue" })).toBeDisabled();
    await saved.check();
  }
  await page.getByRole("button", { name: "I Saved Them, Continue" }).click();
  await page.waitForURL((u) => u.pathname !== "/mfa");
  return { secret, codes };
}

/**
 * The platform team's sign-in: password, then the authenticator code (two-step verification is mandatory for the
 * platform role, 20261120000900). Lands on the launchpad or, after a demo was opened, its Command Center.
 */
export async function signInPlatform(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/^Email/).fill(PLATFORM_USER.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // A fresh platform session always stops at the code (redirects pass through the landing page first).
  await page.waitForURL((u) => u.pathname === "/mfa");
  await page.getByLabel("6-digit code").fill(totp(platformTotpSecret()));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.waitForURL((u) => u.pathname !== "/mfa");
}

export const unique = () => Date.now().toString(36).slice(-6);

export async function expectToast(page: Page, text: string | RegExp) {
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: text }).first()).toBeVisible();
}

/**
 * In a demo company the welcome dialog opens on a person's first visit (docs/DEMO_TENANTS.md §2). Wait for it and
 * close it the way a person does, so the page behind is usable; it is remembered, so later pages show no dialog.
 */
export async function closeDemoWelcome(page: Page) {
  const welcome = page.getByRole("dialog", { name: "Welcome to the Taviron demo" });
  await expect(welcome).toBeVisible();
  // The dismissal is saved by a server action; wait for it so the next page load does not show the welcome again
  // (a fresh demo's automatic refresh can keep the server busy for a while).
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined, { timeout: 30_000 });
  await welcome.getByRole("button", { name: "Explore the demo" }).click();
  await expect(welcome).toHaveCount(0);
  await saved;
}

/** Close the demo welcome if it is open (a platform user's current company may be a demo they have not opened yet). */
export async function closeDemoWelcomeIfShown(page: Page) {
  const welcome = page.getByRole("dialog", { name: "Welcome to the Taviron demo" });
  try {
    await welcome.waitFor({ state: "visible", timeout: 3000 });
  } catch {
    return; // not a demo company, or already dismissed
  }
  await welcome.getByRole("button", { name: "Explore the demo" }).click();
  await expect(welcome).toHaveCount(0);
}
