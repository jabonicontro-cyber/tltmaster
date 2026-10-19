import { expect, test } from "@playwright/test";
import { signIn, signInPlatform } from "./helpers";

// Testing Lab (20261120000800): the platform owner opens real experiences inside a demo company — here the customer
// portal as a demo customer (database-enforced, one hour, audited) — and records what was checked. Ordinary users
// never see the lab.

test("the platform owner previews a demo customer's portal and records the check", async ({ page }) => {
  test.slow();
  await signInPlatform(page);
  await page.goto("/admin/testing-lab");
  await expect(page.getByRole("heading", { name: "Testing Lab" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Platform" }).getByRole("link", { name: "Testing Lab" })).toBeVisible();

  const demo = page.getByLabel("Demo company");
  const presenter = await demo.locator("option", { hasText: "presenter demo" }).first().getAttribute("value");
  test.skip(!presenter, "No presenter demo on this database (created by platform.spec).");
  await page.goto(`/admin/testing-lab?demo=${presenter}`);
  await expect(page.getByText("Demo (fictional data)")).toBeVisible();

  const turnOn = page.getByRole("button", { name: "Turn On Demo Portal" });
  if (await turnOn.isVisible()) {
    await turnOn.click();
    await expect(page.getByRole("button", { name: "Preview as Customer" })).toBeVisible();
  }
  await page.getByRole("button", { name: "Preview as Customer" }).click();
  await page.waitForURL(/\/portal\/[a-z0-9-]+$/);
  await expect(page.getByRole("status").filter({ hasText: "Testing Lab preview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Welcome, / })).toBeVisible();
  await expect(page.getByText("Demo portal: fictional company and records.")).toBeVisible();
  // The preview never signs in as the customer: no sign-out of their account is offered.
  await expect(page.getByRole("button", { name: "Sign Out" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  await page.getByRole("button", { name: "End Preview" }).click();
  await page.waitForURL(/\/admin\/testing-lab/);

  // Record the check against this demo.
  await page.goto(`/admin/testing-lab?demo=${presenter}`);
  const row = page.locator("#check-customer\\.portal");
  await row.getByText("Record a result").click();
  await row.getByLabel("Result").selectOption("tested");
  await row.getByLabel("What you checked").fill("Overview and orders as a demo customer");
  await row.getByRole("button", { name: "Record" }).click();
  await expect(page.locator("#check-customer\\.portal").getByText("Overview and orders as a demo customer")).toBeVisible();
});

test("ordinary users cannot reach the Testing Lab", async ({ page }) => {
  await signIn(page, "owner");
  const r = await page.goto("/admin/testing-lab");
  expect(r?.status()).toBe(404);
});
