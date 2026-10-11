import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// The desktop sidebar is a compact icon rail that expands on hover or keyboard
// focus and can be pinned; phones keep the menu button. The greeting uses the
// signed-in person's own name.

const width = async (page: import("@playwright/test").Page) => (await page.getByRole("complementary", { name: "Sidebar" }).boundingBox())?.width ?? 0;

test("the rail expands on hover and focus, collapses again, and a pin survives a reload", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/command-center");
  await expect(page.getByTestId("greeting")).toHaveText(/^(Hi, \S+!|Welcome back!)$/);

  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar).toHaveAttribute("data-expanded", "false");
  expect(await width(page)).toBeLessThan(80);
  // Every destination is still there, with its accessible name, while collapsed.
  await expect(sidebar.getByRole("link", { name: "Dispatch" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Dispatch" })).toHaveAttribute("href", "/dispatch");

  await sidebar.hover();
  await expect(sidebar).toHaveAttribute("data-expanded", "true");
  await page.mouse.move(900, 450);
  await expect(sidebar).toHaveAttribute("data-expanded", "false");

  // Keyboard: focus inside expands it; Escape returns focus to the page.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 4 && !(await sidebar.evaluate((el) => el.contains(document.activeElement))); i++) await page.keyboard.press("Tab");
  await expect(sidebar).toHaveAttribute("data-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(sidebar).toHaveAttribute("data-expanded", "false");

  // Pinned: stays open, the page makes room, and the choice survives a reload.
  await sidebar.hover();
  await sidebar.getByRole("button", { name: "Keep sidebar open" }).click();
  await page.mouse.move(900, 450);
  await expect(sidebar).toHaveAttribute("data-expanded", "true");
  await expect(page.locator(".app-root")).toHaveAttribute("data-sidebar", "pinned");
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveAttribute("data-expanded", "true");
  const main = await page.locator("#main").boundingBox();
  expect(main?.x ?? 0).toBeGreaterThanOrEqual(256);

  await page.getByRole("button", { name: "Unpin sidebar" }).click();
  await page.mouse.move(900, 450);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveAttribute("data-expanded", "false");
});

test("role permissions still decide what the sidebar offers", async ({ page }) => {
  await signIn(page, "mechanic");
  await page.goto("/command-center");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("link", { name: "Fleet" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Billing" })).toHaveCount(0);
});

test("phones use the menu button, not the hover rail", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "dispatcher");
  await page.goto("/command-center");
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Dispatch" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
