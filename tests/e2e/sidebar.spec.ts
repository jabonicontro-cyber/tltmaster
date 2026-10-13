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
  await expect(sidebar.getByRole("link", { name: "Dispatch" })).toHaveAttribute("title", "Dispatch"); // tooltip while collapsed

  // Under a loaded dev server the first hover can land before the rail's handlers are attached (hydration); move
  // off and back until it registers, so the test checks the behaviour, not the hydration timing.
  await expect(async () => {
    await page.mouse.move(900, 450);
    await sidebar.hover();
    await expect(sidebar).toHaveAttribute("data-expanded", "true", { timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
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

// Tablets in landscape (and other touch screens at 1024 px or wider) get the rail, which a finger cannot hover: the
// toggle at its top opens and closes it on purpose; tapping outside, Escape or choosing a page closes it again.
test.describe("touch screens", () => {
  test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: false });

  test("the rail opens and closes with the toggle, without hover", async ({ page }) => {
    await signIn(page, "dispatcher");
    await page.goto("/command-center");
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    await expect(sidebar).toHaveAttribute("data-expanded", "false");
    const toggle = sidebar.getByRole("button", { name: "Expand navigation" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect((await toggle.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44); // a comfortable touch target

    await toggle.tap();
    await expect(sidebar).toHaveAttribute("data-expanded", "true");
    await expect(sidebar.getByText("Dispatch", { exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "Collapse navigation" })).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => width(page)).toBeGreaterThan(240); // after the width transition
    // Opened over the page: the content does not move.
    expect((await page.locator("#main").boundingBox())?.x ?? 0).toBeLessThan(200 + 72);

    // Tap outside closes it.
    await page.getByTestId("sidebar-backdrop").tap({ position: { x: 900, y: 400 } });
    await expect(sidebar).toHaveAttribute("data-expanded", "false");

    // Choosing a page navigates and closes it.
    await sidebar.getByRole("button", { name: "Expand navigation" }).tap();
    await sidebar.getByRole("link", { name: "Dispatch" }).tap();
    await page.waitForURL(/\/dispatch/);
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveAttribute("data-expanded", "false");

    // The toggle again collapses it; Escape too.
    await sidebar.getByRole("button", { name: "Expand navigation" }).tap();
    await sidebar.getByRole("button", { name: "Collapse navigation" }).tap();
    await expect(sidebar).toHaveAttribute("data-expanded", "false");
    await sidebar.getByRole("button", { name: "Expand navigation" }).tap();
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveAttribute("data-expanded", "false");
  });

  test("scrolling the page never opens the rail", async ({ page }) => {
    await signIn(page, "dispatcher");
    await page.goto("/dispatch");
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    await page.mouse.wheel(0, 600);
    await page.touchscreen.tap(30, 500); // a tap on a rail icon area that is not the toggle navigates, it does not expand
    await expect(sidebar).toHaveAttribute("data-expanded", "false");
  });

  test("tablets in portrait use the menu button", async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await signIn(page, "dispatcher");
    await page.goto("/command-center");
    await expect(page.getByRole("complementary", { name: "Sidebar" })).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).tap();
    await expect(page.getByRole("dialog").getByRole("link", { name: "Dispatch" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("keyboard: the toggle is reachable, labelled and works with Enter", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/command-center");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const toggle = sidebar.getByRole("button", { name: /Expand navigation|Collapse navigation/ });
  await toggle.focus();
  await expect(sidebar).toHaveAttribute("data-expanded", "true"); // keyboard focus inside opens it, as before
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

// Unfinished modules are labelled "Coming soon" (owner 2026-10-13), never shown as working features.
test("unfinished modules say Coming soon in the sidebar and on their page", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/command-center");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(async () => {
    await page.mouse.move(900, 450);
    await sidebar.hover();
    await expect(sidebar).toHaveAttribute("data-expanded", "true", { timeout: 1_500 });
  }).toPass({ timeout: 15_000 });
  await expect(sidebar.getByRole("link", { name: /Route Planner/ })).toContainText("Coming soon");
  await page.goto("/route-planner");
  await expect(page.getByText(/^Coming soon — scheduled for/)).toBeVisible();
  await expect(page.getByText("Nothing on this page is live.")).toBeVisible();
});
