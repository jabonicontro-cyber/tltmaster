import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Reports period: From and To accept typed dates (MM/DD/YYYY), edits and pastes, keep the calendar as an
// alternative, validate impossible, incomplete and reversed dates before Show, and leave the presets working.

test.beforeEach(async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/reports?days=30");
});

const from = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "From" });
const to = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "To" });

test("typing 10/19/2026 into both fields shows that day", async ({ page }) => {
  await from(page).fill("");
  await from(page).pressSequentially("10/19/2026");
  await to(page).fill("");
  await to(page).pressSequentially("10/19/2026");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/from=2026-10-19&to=2026-10-19/);
  await expect(page.getByText(/Oct 19, 2026 – Oct 19, 2026/)).toBeVisible();
  await expect(from(page)).toHaveValue("10/19/2026");
});

test("editing digits, selecting all and pasting work; two-digit years mean the 2000s", async ({ page }) => {
  await from(page).fill("10/19/2026");
  // Edit one digit: move to the end, delete the last digit, type another.
  await from(page).press("End");
  await from(page).press("Backspace");
  await from(page).pressSequentially("5");
  await expect(from(page)).toHaveValue("10/19/2025");
  // Select all and paste.
  await to(page).click();
  await to(page).press("ControlOrMeta+a");
  // A paste replaces the selection with the pasted text in one input event.
  await page.keyboard.insertText("11/02/25");
  await to(page).blur();
  await expect(to(page)).toHaveValue("11/02/2025");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/from=2025-10-19&to=2025-11-02/);
});

test("impossible, incomplete, empty and reversed dates are explained and not submitted", async ({ page }) => {
  const url = page.url();
  await from(page).fill("02/29/2026");
  await from(page).blur();
  await expect(page.getByRole("alert").filter({ hasText: "02/2026 has 28 days." })).toBeVisible();
  await expect(from(page)).toHaveValue("02/29/2026"); // left as typed, not moved to March 1
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(url);

  await from(page).fill("02/29/2028");
  await from(page).blur();
  await expect(page.getByRole("alert").filter({ hasText: "has 28 days" })).toHaveCount(0);

  await to(page).fill("10/19");
  await to(page).blur();
  await expect(page.getByRole("alert").filter({ hasText: "MM/DD/YYYY" })).toBeVisible();

  await to(page).fill("");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Enter a date as MM/DD/YYYY." })).toBeVisible();
  await expect(page).toHaveURL(url);

  await from(page).fill("10/19/2026");
  await to(page).fill("10/01/2026");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "To must be on or after From." })).toBeVisible();
  await expect(page).toHaveURL(url);
});

test("choosing a date in the calendar fills the field", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Open calendar for From" })).toBeVisible();
  // The calendar is the browser's own; selecting a day sets the hidden date input, which updates the text.
  await page.locator('input[type="date"]').first().fill("2026-09-03");
  await expect(from(page)).toHaveValue("09/03/2026");
  await page.locator('input[type="date"]').nth(1).fill("2026-09-30");
  await expect(to(page)).toHaveValue("09/30/2026");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(/from=2026-09-03&to=2026-09-30/);
});

test("presets still set the period and the fields follow", async ({ page }) => {
  for (const days of [7, 30, 90]) {
    await page.getByRole("link", { name: `Last ${days} days` }).click();
    await expect(page).toHaveURL(new RegExp(`days=${days}`));
    await expect(from(page)).toHaveValue(/^\d{2}\/\d{2}\/\d{4}$/);
    await expect(to(page)).toHaveValue(/^\d{2}\/\d{2}\/\d{4}$/);
  }
});

test("the period form fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(from(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
