import { expect, test } from "@playwright/test";
import { SITE_PAGES } from "../../src/lib/site/paths";

// The public website (docs/MARKETING.md): every page renders with one heading and no errors, every navigation and
// footer link reaches a page, the menus work with a keyboard, the phone menu works, a demo request keeps what the
// visitor was looking at, and nothing scrolls sideways on a phone.

test("every public page renders with one heading and no console errors", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const p of SITE_PAGES) {
    const res = await page.goto(p);
    expect(res?.status(), p).toBe(200);
    await expect(page.locator("h1"), p).toHaveCount(1);
  }
  expect(errors).toEqual([]);
});

test("every header and footer link reaches a page", async ({ page, request }) => {
  await page.goto("/");
  const hrefs = new Set<string>();
  for (const h of await page.locator("header a[href^='/'], footer a[href^='/'], #site-nav-Platform a, #site-nav-Solutions a").evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))) hrefs.add(h);
  expect(hrefs.size).toBeGreaterThan(15);
  for (const h of hrefs) {
    const res = await request.get(h, { maxRedirects: 0 });
    expect([200, 307, 308], h).toContain(res.status());
  }
});

test("the Platform menu opens with the keyboard, links to every area and closes with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Platform" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const menu = page.locator("#site-nav-Platform");
  for (const name of ["Smart Dispatch & Load Management", "Fleet & Maintenance", "Customer & Order Management", "Operational Intelligence & AI", "Automation & Connected Workflows", "Integrations, Reporting & Control"]) {
    await expect(menu.getByRole("link", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toBeFocused();
  await button.click();
  await menu.getByRole("link", { name: /^Fleet & Maintenance/ }).click();
  await expect(page).toHaveURL(/\/platform\/fleet$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The shop and dispatch work from the same truck record.");
  await expect(page.getByRole("button", { name: "Platform" })).toHaveAttribute("aria-expanded", "false");
});

test("the Intelligence page says plainly that AI is not switched on yet", async ({ page }) => {
  await page.goto("/platform/intelligence");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Know what's happening. Understand why. Decide what comes next.");
  await expect(page.getByRole("list", { name: "Not available yet" })).toContainText("AI assistance is built but not switched on");
});

test("a demo request from a platform page keeps the visitor's interest", async ({ page }) => {
  await page.goto("/platform/dispatch");
  await page.getByRole("main").getByRole("link", { name: "Request a demo" }).first().click();
  await expect(page).toHaveURL(/\/demo\?interest=dispatch$/);
  await expect(page.locator('textarea[name="message"]')).toHaveValue("Interested in: Smart Dispatch & Load Management");
  // Unknown interests are ignored.
  await page.goto("/demo?interest=<script>");
  await expect(page.locator('textarea[name="message"]')).toHaveValue("");
});

test("pricing on solutions pages matches the pricing page", async ({ page }) => {
  await page.goto("/solutions/small-fleets");
  await expect(page.getByRole("heading", { name: "Essential" })).toBeVisible();
  await expect(page.getByText("$499").first()).toBeVisible();
  await page.goto("/pricing");
  await expect(page.getByText("$499").first()).toBeVisible();
});

test("on a phone the menu works and no page scrolls sideways", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const menu = page.locator("details.site-menu");
  const isOpen = () => menu.evaluate((d) => (d as HTMLDetailsElement).open);
  const button = page.getByLabel("Menu");
  // A comfortable touch target.
  const box = await button.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Trust & Security" }).click();
  await expect(page).toHaveURL(/\/trust$/);
  // The menu closes after a link is followed (the header stays mounted across pages)…
  await expect.poll(isOpen).toBe(false);
  // …on Escape, with focus back on the button…
  await button.click();
  await expect.poll(isOpen).toBe(true);
  await page.keyboard.press("Escape");
  await expect.poll(isOpen).toBe(false);
  await expect(button).toBeFocused();
  // …and on a tap outside it, which does not also press what was underneath.
  await button.click();
  await expect.poll(isOpen).toBe(true);
  await page.mouse.click(20, 700);
  await expect.poll(isOpen).toBe(false);
  await expect(page).toHaveURL(/\/trust$/);
  for (const p of SITE_PAGES) {
    await page.goto(p);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), p).toBeLessThanOrEqual(0);
  }
});

test("the paperwork calculator works out the visitor's own numbers and sends nothing", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() !== "GET") posts.push(r.url()); });
  await page.goto("/calculator");
  await expect(page.getByText("Enter your trucks, loads, days and minutes per ticket")).toBeVisible();
  await page.getByLabel("Trucks hauling on a typical day").fill("10");
  await page.getByLabel("Loads per truck per day").fill("6");
  await page.getByLabel("Working days per week").fill("5");
  await page.getByLabel("Office minutes per ticket").fill("4");
  await expect(page.getByText("Delivery tickets a week").locator("..")).toContainText("300");
  await expect(page.getByText("Office hours a week on tickets").locator("..")).toContainText("20");
  await expect(page.getByText("Cost a year")).toHaveCount(0);
  await page.getByLabel("Office cost per hour ($)").fill("30");
  await expect(page.getByText("Cost a year").locator("..")).toContainText("$31,200");
  expect(posts).toEqual([]);
});

test("comparisons, guides and the link preview", async ({ page, request }) => {
  await page.goto("/compare/spreadsheets");
  await expect(page.getByRole("table", { name: /compared with Taviron/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What Taviron does not do yet." })).toBeVisible();
  await page.getByRole("link", { name: /All-in-one vs dispatch-only/ }).last().click();
  await expect(page).toHaveURL(/\/compare\/dispatch-only$/);
  await page.goto("/guides");
  await page.getByRole("navigation", { name: "Guides" }).getByRole("link", { name: "Plan the day" }).click();
  await expect(page.getByRole("heading", { name: "Plan the day", level: 2 })).toBeInViewport();
  // Every page shares the preview image, on the public domain, with its own canonical address.
  await page.goto("/pricing");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://mytaviron.com/og/taviron.png");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://mytaviron.com/pricing");
  expect((await request.get("/og/taviron.png")).status()).toBe(200);
});

test("motion: the opening animates, and nothing moves for people who ask for reduced motion", async ({ browser }) => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    await page.goto("/");
    const name = await page.locator("#hero-title").evaluate((e) => getComputedStyle(e).animationName);
    expect(name, reducedMotion).toBe(reducedMotion === "reduce" ? "none" : "site-enter");
    await ctx.close();
  }
});
