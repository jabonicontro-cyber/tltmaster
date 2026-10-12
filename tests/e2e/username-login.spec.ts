import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { unique } from "./helpers";

// Username accounts: the operator prints a one-time link (nothing is emailed), the
// person chooses their own password, signs in with the username, and — once made
// owner of a prospect demo — lands in that demo company only. Local stack only.

const script = (...args: string[]) => execFileSync("node", ["scripts/platform-admin.mjs", ...args], { env: process.env, encoding: "utf8" });

async function prospectDemo() {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    const slug = `prospect-e2e${randomUUID().slice(0, 8)}`;
    const id = (await c.query<{ id: string }>("select private.create_company($1, $2) as id", [`E2E Prospect Demo ${unique()}`, slug])).rows[0].id;
    await c.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [id]);
    return slug;
  } finally {
    await c.end();
  }
}

test("a username account sets its own password, signs in with the username, and sees only its prospect demo", async ({ page }) => {
  const username = `e2e-user-${unique()}`;
  const password = `Pw-${randomUUID()}`;
  const out = script("setup-link", username, "--base-url", process.env.E2E_BASE_URL ?? "http://localhost:3000");
  expect(out).toContain(`Created a login for username ${username}`);
  const link = out.split("\n").find((l) => l.includes("/auth/confirm?"))!.trim();

  await page.goto(link);
  await page.waitForURL(/\/update-password/);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: /password/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/update-password"));

  const slug = await prospectDemo();
  expect(script("demo-owner", username, slug)).toContain("is now the owner of the demo company");
  // Real companies are refused.
  expect(() => script("demo-owner", username, "top-line-trucking")).toThrow();

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(username);
  await page.getByLabel("Password").fill("wrong-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Username or password is incorrect.")).toBeVisible();
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/command-center/);
  await expect(page.getByRole("region", { name: "Demo company" })).toBeVisible();
  await expect(page.locator("body")).toContainText("Owner / Administrator · E2E Prospect Demo");
  await expect(page.getByText(username).first()).toBeVisible(); // shown as the username, never the internal address
  await expect(page.getByText("users.mytaviron.com")).toHaveCount(0);

  // No reset email for a username account.
  await page.context().clearCookies();
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(username);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/cannot get a reset email/)).toBeVisible();
});
