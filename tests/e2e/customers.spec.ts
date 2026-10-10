import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";

test("office staff create, find, extend and archive a customer", async ({ page }) => {
  const name = `E2E Hauling Customer ${unique()}`;
  await signIn(page, "office");
  await page.goto("/customers/new");

  // Validation: invalid email is reported and other input is kept.
  await page.getByLabel("Customer name").fill(name);
  await page.getByLabel("Main email").fill("not-an-email");
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await expect(page.getByLabel("Customer name")).toHaveValue(name);

  await page.getByLabel("Main email").fill("office@e2e.example");
  await page.getByLabel("Contact name").fill("Chris Contact");
  await page.getByLabel("City").fill("Valparaiso");
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("Chris Contact")).toBeVisible();

  await page.getByRole("button", { name: "Add job site" }).click();
  await page.getByLabel("Site name").fill("North pit road");
  await page.getByLabel("Street address").fill("123 Test Quarry Rd");
  await page.getByRole("button", { name: "Save job site" }).click();
  await expectToast(page, "Job site added.");
  await expect(page.getByText("123 Test Quarry Rd")).toBeVisible();

  await page.goto(`/customers?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("link", { name })).toBeVisible();

  await page.getByRole("link", { name }).click();
  await page.getByRole("button", { name: "Archive" }).first().click();
  await page.getByRole("button", { name: "Archive customer" }).click();
  await expect(page.getByText("Archived customer")).toBeVisible();
});
