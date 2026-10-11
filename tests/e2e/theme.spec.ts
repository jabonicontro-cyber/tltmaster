import { expect, test, type Page } from "@playwright/test";
import { asUser } from "./db";
import { signIn } from "./helpers";
import { USERS } from "./users";

// Light and dark mode: a per-person display choice in the user menu, kept in
// the browser. Urgency keeps its fixed red, the company's brand color still
// applies, and the public website and documents stay light.

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const bg = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);

async function choose(page: Page, label: "Light" | "Dark" | "Match my device") {
  await page.getByRole("banner").getByRole("button").last().click();
  await page.getByRole("menuitemradio", { name: label }).click();
  await page.keyboard.press("Escape");
}

test("the appearance choice switches the app to dark, survives a reload, and keeps urgency red and the company's brand", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signIn(page, "owner");
  await page.goto("/command-center");
  expect(await theme(page)).toBe("light");
  expect(await bg(page, "body")).toBe("rgb(244, 245, 247)");

  await choose(page, "Dark");
  await expect.poll(() => theme(page)).toBe("dark");
  await page.reload();
  expect(await theme(page)).toBe("dark");
  expect(await bg(page, "body")).toBe("rgb(11, 21, 34)");
  expect(await bg(page, "#main .bg-card")).toBe("rgb(17, 29, 44)"); // cards and panels

  // The company's accent stays its own; urgency stays the fixed critical red.
  const brand = await page.locator("#main").evaluate((el) => getComputedStyle(el).getPropertyValue("--color-brand").trim());
  expect(brand).toBe("#0f6fd6");
  const urgent = page.getByRole("region", { name: "Attention summary" }).getByRole("link", { name: /urgent$/ });
  if (await urgent.count()) expect(await urgent.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(185, 28, 28)");

  // The public website keeps its own light tokens inside .site.
  await page.goto("/pricing");
  expect(await page.locator(".site").evaluate((el) => getComputedStyle(el).getPropertyValue("--color-card").trim())).toMatch(/^#fff(fff)?$/i);

  // "Match my device" follows the device setting.
  await page.goto("/command-center");
  await choose(page, "Match my device");
  await expect.poll(() => theme(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => theme(page)).toBe("dark");

  await page.emulateMedia({ colorScheme: "light" });
  await choose(page, "Light");
  await expect.poll(() => theme(page)).toBe("light");
});

test("documents stay light in dark mode", async ({ page }) => {
  await signIn(page, "owner");
  await page.evaluate(() => localStorage.setItem("taviron-theme", "dark"));
  const version = await asUser(USERS.owner.email, async (q) => (await q("select quote_id, id from public.quote_versions order by created_at desc limit 1")).rows[0]);
  test.skip(!version, "no quote version to open");
  await page.goto(`/quotes/${version.quote_id}/versions/${version.id}`);
  await expect(page.locator("article.force-light")).toBeVisible();
  expect(await theme(page)).toBe("dark");
  expect(await bg(page, "article.force-light")).toBe("rgb(255, 255, 255)");
  await page.evaluate(() => localStorage.removeItem("taviron-theme"));
});
