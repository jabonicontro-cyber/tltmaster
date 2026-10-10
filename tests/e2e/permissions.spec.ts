import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("an account without a role sees the waiting page and no data", async ({ page }) => {
  await signIn(page, "pending");
  await expect(page).toHaveURL(/\/no-access/);
  await expect(page.getByRole("heading", { name: "Your account is waiting for access" })).toBeVisible();
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/no-access/);
});

test("dispatchers can view quotes but cannot create or change them", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/quotes");
  await expect(page.getByRole("heading", { name: "Quotes" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New quote" })).toHaveCount(0);
  await page.goto("/quotes/new");
  await expect(page).toHaveURL(/\/no-access\?missing=quotes.edit/);
  await page.goto("/settings?tab=users");
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
});

test("the PDF route refuses anonymous requests", async ({ request }) => {
  const res = await request.get("/quotes/00000000-0000-0000-0000-000000000000/versions/00000000-0000-0000-0000-000000000000/pdf", { maxRedirects: 0 });
  expect([302, 303, 307, 403]).toContain(res.status());
});
