import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";

test("add a material and give it a dated standard rate", async ({ page }) => {
  const name = `E2E Crushed Concrete ${unique()}`;
  await signIn(page, "office");
  await page.goto("/materials");
  await page.getByRole("button", { name: "Add material" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Save material" }).click();
  await expectToast(page, "Material added.");
  await expect(page.getByText(name)).toBeVisible();

  await page.goto("/materials?tab=prices");
  await page.getByRole("link", { name: "Standard rates" }).click();
  await page.getByRole("button", { name: "Add rate" }).click();
  await page.getByLabel("Material or charge").selectOption({ label: name });
  await page.getByLabel("Rate ($ per unit)").fill("abc");
  await page.getByRole("button", { name: "Save rate" }).click();
  await expect(page.getByText("Enter a rate like 12.50.")).toBeVisible();
  await page.getByLabel("Rate ($ per unit)").fill("11.25");
  await page.getByRole("button", { name: "Save rate" }).click();
  await expectToast(page, "Rate added.");
  await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("$11.25");
});
