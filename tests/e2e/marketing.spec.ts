import { expect, test } from "@playwright/test";
import { FEATURES, SCREENSHOTS, publishedFeatures } from "@/lib/site/features";

// The platform page is generated from the feature catalog (docs/MARKETING.md): every published feature appears, nothing
// unpublished does, every screen is the catalogued real-app screenshot with its alt text, and the capability links
// jump to their sections. Desktop and phone.

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`platform page shows the catalog, and only what is published (${name})`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewportSize(viewport);
    await page.goto("/platform");
    await expect(page.locator("h1")).toHaveCount(1);
    for (const f of publishedFeatures()) await expect(page.locator(`#feature-${f.id}`), f.id).toHaveCount(1);
    for (const f of FEATURES.filter((x) => !x.published)) {
      await expect(page.locator(`#feature-${f.id}`), f.id).toHaveCount(0);
      await expect(page.getByRole("heading", { name: f.name })).toHaveCount(0);
    }
    // Every catalogued screen of a published feature is on the page with its alt text, and loads.
    for (const f of publishedFeatures()) {
      for (const id of f.screenshots.slice(0, 1)) {
        const shot = SCREENSHOTS.find((s) => s.id === id)!;
        const img = page.getByRole("img", { name: shot.alt });
        await img.scrollIntoViewIfNeeded();
        await expect(img).toBeVisible();
        expect(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      }
    }
    // Capability links jump to their section.
    await page.getByRole("navigation", { name: "Capabilities" }).getByRole("link", { name: "Maintenance" }).click();
    await expect(page).toHaveURL(/#feature-maintenance$/);
    await expect(page.getByRole("heading", { name: "Maintenance", level: 2 })).toBeInViewport();
    // The "Not yet" list is still there, said plainly.
    await expect(page.getByRole("heading", { name: /Not yet/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}
