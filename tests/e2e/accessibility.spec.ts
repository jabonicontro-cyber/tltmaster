import { expect, test } from "@playwright/test";
import { expectToast, signIn } from "./helpers";

// Accessibility mode (owner 2026-11-05, UX19): settings apply at once, survive a reload, and follow the person to
// another browser (saved with their account, not only in this browser). The public website ignores them.
test("a person turns on larger text and high contrast, and they follow them to a new browser", async ({ page, browser }) => {
  await signIn(page, "office");
  await page.goto("/profile");
  const a11y = page.getByRole("region", { name: "Accessibility" });
  await a11y.getByRole("radio", { name: /Larger/ }).check();
  await expectToast(page, "Accessibility settings saved.");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "115");
  // Wait for the first save's message to go, so the next check waits for the second save (not a leftover toast).
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Accessibility settings saved." })).toHaveCount(0, { timeout: 15_000 });
  await a11y.getByRole("checkbox", { name: /High contrast/ }).check();
  await expectToast(page, "Accessibility settings saved.");
  await expect(page.locator("html")).toHaveAttribute("data-contrast", "high");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "115");
  await expect(page.getByRole("region", { name: "Accessibility" }).getByRole("checkbox", { name: /High contrast/ })).toBeChecked();

  // Another browser with nothing stored: the account brings the settings.
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await signIn(page2, "office");
  await page2.goto("/command-center");
  await expect(page2.locator("html")).toHaveAttribute("data-text-size", "115");
  await expect(page2.locator("html")).toHaveAttribute("data-contrast", "high");
  // The larger text really is larger.
  expect(await page2.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBeGreaterThan(17);
  await other.close();

  // Back to the defaults (shared test account).
  await page.getByRole("region", { name: "Accessibility" }).getByRole("radio", { name: /Standard/ }).check();
  await expectToast(page, "Accessibility settings saved.");
  await page.getByRole("region", { name: "Accessibility" }).getByRole("checkbox", { name: /High contrast/ }).uncheck();
  await expect(page.locator("html")).not.toHaveAttribute("data-contrast", "high");
  await expect(page.locator("html")).not.toHaveAttribute("data-text-size", /./);
});
