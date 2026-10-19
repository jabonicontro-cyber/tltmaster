import { expect, test } from "@playwright/test";

// Homepage hero (owner 2026-10-19): a static hero with the real product (screens from the demo company), replacing the
// scroll-driven 3D truck. On every screen size: the message, both calls to action and the product screen are visible,
// nothing scrolls sideways, there are no console errors, and reduced motion changes nothing that matters.

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["tablet", { width: 1024, height: 1366 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`homepage hero shows the message and the real product (${name})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "A smarter way to run a fleet." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a demo" }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "See what it does today" })).toBeVisible();
    const shot = page.getByRole("img", { name: /The Taviron Command Center for a demo company/ }).first();
    await expect(shot).toBeVisible();
    // No 3D canvas any more.
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "The office work follows the truck." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("reduced motion: the same hero, nothing animated that carries meaning", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "A smarter way to run a fleet." })).toBeVisible();
  await expect(page.locator("canvas")).toHaveCount(0);
  await context.close();
});
