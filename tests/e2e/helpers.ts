import { expect, type Page } from "@playwright/test";
import { PASSWORD, PLATFORM_USER, USERS, type UserKey } from "./users";
import { platformTotpSecret, totp } from "./mfa";

export async function signIn(page: Page, who: UserKey) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS[who].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
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
  await welcome.getByRole("button", { name: "Explore the demo" }).click();
  await expect(welcome).toHaveCount(0);
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
