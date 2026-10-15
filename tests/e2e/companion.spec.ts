import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { driverFixture } from "./driver-fixture";

// Taviron companion app (docs/COMPANION_APP.md): the installable web app on the same backend. Phone-sized checks.

test("the app can be installed: manifest, icons and service worker are served without signing in", async ({ request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.status()).toBe(200);
  const manifest = await m.json();
  expect(manifest).toMatchObject({ name: "Taviron", start_url: "/dashboard", display: "standalone" });
  for (const icon of manifest.icons as Array<{ src: string }>) expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(await sw.text()).toContain("never stores company data");
  // Nothing private is reachable without signing in.
  const driver = await request.get("/driver", { maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(driver.status());
});

test("a driver on a phone gets tabs, a freshness line and dispatch updates they can dismiss", async ({ page }) => {
  const f = await driverFixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "driver");
  await page.goto("/driver");
  const tabs = page.getByRole("navigation", { name: "Driver tabs" });
  await expect(tabs.getByRole("link", { name: "My Day" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "Time off" })).toBeVisible();
  await expect(page.getByText(/^Updated \d{1,2}:\d{2}/)).toBeVisible();
  await expect(page.getByText("Use Taviron only when you are parked.")).toBeVisible();

  const updates = page.getByRole("region", { name: "Updates from dispatch" });
  const item = updates.getByRole("listitem").filter({ hasText: `New load: ${f.orderNumber} load 2` });
  await expect(item).toBeVisible();
  await item.getByRole("button", { name: "Got it" }).click();
  await expect(item).toHaveCount(0);

  // Offline: the page says so instead of presenting the loads as current.
  await page.context().setOffline(true);
  await expect(page.getByRole("status").filter({ hasText: "No connection." })).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.getByText(/^Updated \d{1,2}:\d{2}/)).toBeVisible();
});

test("office staff keep the full menu on a phone (no driver tabs)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "office");
  await page.goto("/time-off");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Driver tabs" })).toHaveCount(0);
});

test("with no connection the app shows the offline page, never old company data", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "driver");
  await page.goto("/driver");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); // the service worker now controls the page
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.context().setOffline(true);
  await page.goto("/driver").catch(() => {});
  await expect(page.getByRole("heading", { name: "No connection" })).toBeVisible();
  await expect(page.getByText("nothing is shown here")).toBeVisible();
  await page.context().setOffline(false);
});
