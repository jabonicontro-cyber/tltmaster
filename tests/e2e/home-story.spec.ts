import { expect, test } from "@playwright/test";

// Homepage 3D story (docs/WEBSITE_3D.md): one scene per chapter, in step with the text; the truck stays in view on
// every screen size; reduced motion keeps one still pose; no sideways scrolling; no console errors.

const story = (page: import("@playwright/test").Page) => page.locator(".truck-story");

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["tablet portrait (wide layout)", { width: 1024, height: 1366 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`homepage story follows the text, chapter by chapter (${name})`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(story(page)).toHaveAttribute("data-mode", "3d", { timeout: 20_000 });
    await expect(story(page)).toHaveAttribute("data-ready", "yes", { timeout: 60_000 });
    const steps = page.locator("[data-story-step]");
    const count = await steps.count();
    expect(count).toBe(6); // the intro and five chapters, one scene each
    for (let i = 0; i < count; i++) {
      await steps.nth(i).evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect(story(page)).toHaveAttribute("data-scene", String(i));
    }
    // The canvas is decorative; the story text is ordinary, readable content.
    await expect(page.locator(".truck-visual")).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("heading", { name: "The office work follows the truck." })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("reduced motion: one still pose, scrolling does not move the scene", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(story(page)).toHaveAttribute("data-mode", "3d-still", { timeout: 20_000 });
  await page.locator("[data-story-step]").nth(3).evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(500);
  await expect(story(page)).toHaveAttribute("data-scene", "0");
  await context.close();
});

test("without WebGL the static truck illustration stays and the story still reads", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      if (/webgl/i.test(type)) return null;
      return (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/");
  await page.waitForTimeout(2000);
  await expect(story(page)).toHaveAttribute("data-mode", "static");
  await expect(page.locator(".truck-visual canvas")).toHaveCount(0);
  await expect(page.locator(".truck-visual svg").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Promises you can keep." })).toBeVisible();
});
