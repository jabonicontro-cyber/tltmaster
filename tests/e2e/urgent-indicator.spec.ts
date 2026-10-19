import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Command Center status strip (20261119000200): one urgent indicator whose parts add up to its total — never "N urgent"
// plus a separate "N urgent orders" for the same items. At phone width the strip wraps instead of overflowing.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`one urgent indicator, parts add up (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await signIn(page, "office");
    await page.goto("/command-center");
    const strip = page.getByRole("region", { name: "Attention summary" });
    await expect(strip).toBeVisible();
    const links = await strip.getByRole("link").allTextContents();
    const urgent = links.map((t) => t.replace(/^·\s*/, "").trim()).filter((t) => /urgent|without a truck|refuse|report|by tomorrow|^\d+ orders?$/.test(t));
    // Never a separate "N urgent orders" next to the urgent total.
    expect(links.filter((t) => /urgent orders?$/.test(t.trim())).length).toBeLessThanOrEqual(1);
    if (urgent.length > 1) {
      const total = Number(urgent[0].match(/^(\d+) urgent$/)?.[1]);
      const parts = urgent.slice(1).map((t) => Number(t.match(/^(\d+)/)?.[1] ?? 0));
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
    const overflow = await strip.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });
}
