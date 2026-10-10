import { expect, type Page } from "@playwright/test";
import { PASSWORD, USERS, type UserKey } from "./users";

export async function signIn(page: Page, who: UserKey) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(USERS[who].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
}

export const unique = () => Date.now().toString(36).slice(-6);

export async function expectToast(page: Page, text: string | RegExp) {
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: text }).first()).toBeVisible();
}
