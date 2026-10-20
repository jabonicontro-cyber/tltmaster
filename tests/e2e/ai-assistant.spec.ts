import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Ask Taviron (docs/AI.md §12) on the local stack, which has no AI provider configured: the page opens from the header
// for people who may use it, says honestly that it is not available and why (reasons for administrators only), points
// to the pages with the same records, and is not offered to a driver-only login. Answers themselves are covered with a
// mocked provider in tests/unit/ai-assistant.test.ts.

test("an owner opens Ask Taviron from the header and sees why it is not available yet", async ({ page }) => {
  await signIn(page, "owner");
  await page.getByRole("link", { name: "Ask Taviron" }).click();
  await expect(page.getByRole("heading", { name: "Ask Taviron", level: 1 })).toBeVisible();
  await expect(page.getByText(/Ask Taviron is not available for this company yet \(Blocked\)/)).toBeVisible();
  await expect(page.getByText("No AI provider is configured.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Company setup" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Command Center" })).toBeVisible();
  // No question box while it cannot answer: nothing pretends to work.
  await expect(page.getByLabel("Your question")).toHaveCount(0);
});

test("a dispatcher sees the same state without the configuration details", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/assistant");
  await expect(page.getByText(/not available for this company yet/)).toBeVisible();
  await expect(page.getByText("No AI provider is configured.")).toHaveCount(0);
  await expect(page.getByText(/An administrator of your company can see what is missing/)).toBeVisible();
});

test("a driver-only login is not offered Ask Taviron and cannot open it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "driver");
  await expect(page.getByRole("link", { name: "Ask Taviron" })).toHaveCount(0);
  await page.goto("/assistant");
  await expect(page).toHaveURL(/\/no-access/);
});

test("the page works on a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "owner");
  await page.goto("/assistant");
  await expect(page.getByRole("heading", { name: "Ask Taviron", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
