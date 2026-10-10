import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { USERS } from "./users";

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
