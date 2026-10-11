import { expect, test, type Page } from "@playwright/test";
import { expectToast, signIn } from "./helpers";

// Company branding (N15): an owner sets the accent color; their company sees
// it, another company does not; colors too light for white text are refused.

const brandVar = (page: Page) => page.locator("#main").evaluate((el) => getComputedStyle(el).getPropertyValue("--color-brand").trim());

test("an owner's brand color applies to their own company only", async ({ page, browser }) => {
  await signIn(page, "owner");
  await page.goto("/settings?tab=company");
  const accent = page.getByRole("textbox", { name: "Accent color", exact: true });
  await accent.fill("#ffee00");
  await expect(page.getByText("Too light: white text on it would be hard to read")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save branding" })).toBeDisabled();
  await accent.fill("#1f6feb");
  await page.getByRole("button", { name: "Save branding" }).click();
  await expectToast(page, "Branding saved.");
  await page.goto("/command-center");
  await expect.poll(() => brandVar(page)).toBe("#1f6feb");
  await expect(page.getByText(/Powered by Taviron/)).toBeVisible();
  // The company's identity leads the workspace; urgency keeps its fixed red whatever the company's colors.
  await expect(page.getByRole("link", { name: /Top Line Trucking — home/ }).first()).toBeVisible();
  const urgent = page.getByRole("region", { name: "Attention summary" }).getByRole("link", { name: /urgent$/ });
  if (await urgent.count()) expect(await urgent.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(185, 28, 28)");

  const other = await browser.newPage();
  await signIn(other, "otherOwner");
  await other.goto("/command-center");
  expect(await brandVar(other)).toBe("#0f6fd6"); // the default (Taviron) accent
  await other.close();

  // Back to the default look so other tests see the standard theme.
  await page.goto("/settings?tab=company");
  await page.getByRole("textbox", { name: "Accent color", exact: true }).fill("");
  await page.getByRole("button", { name: "Save branding" }).click();
  await expectToast(page, "Branding saved.");
});
