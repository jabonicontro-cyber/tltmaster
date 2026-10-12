import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Driver & truck availability for dispatch: shop visits and safety restrictions
// from Maintenance, qualifications from Fleet, and hours of service shown as not
// verified (no ELD data). Fictional data only.

test("availability shows shop visits, safety restrictions and unverified hours of service", async ({ page }) => {
  const tag = unique();
  const today = await asUser(USERS.owner.email, async (q) => {
    const d = (await q("select to_char(now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'), 'YYYY-MM-DD') as d")).rows[0].d as string;
    const shop = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`AV-SHOP-${tag}`])).rows[0].id;
    const safe = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`AV-SAFE-${tag}`])).rows[0].id;
    await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump')", [`AV-OK-${tag}`]);
    await q("select public.maintenance_create_work_order($1::jsonb)", [JSON.stringify({ truck_id: shop, title: `Annual inspection ${tag}`, category: "inspection", scheduled_for: d })]);
    await q("select public.maintenance_create_work_order($1::jsonb)", [JSON.stringify({ truck_id: safe, title: `Steering ${tag}`, safety_critical: true })]);
    return d;
  });

  await signIn(page, "dispatcher");
  await page.goto("/dispatch");
  await page.getByRole("link", { name: "Driver & truck availability" }).click();
  // The page lists every active truck and driver; on the dev server with the test database's hundreds of
  // accumulated test trucks it can take longer than the default 5 s to render.
  await expect(page.getByRole("heading", { name: "Driver & truck availability", level: 1 })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("note").first()).toContainText("Hours of service are not checked");

  await page.goto(`/dispatch/resources?date=${today}&q=AV-`);
  await expect(page.getByRole("row", { name: new RegExp(`AV-SHOP-${tag}`) })).toContainText("In the shop this day");
  await expect(page.getByRole("row", { name: new RegExp(`AV-SAFE-${tag}`) })).toContainText("Safety restricted");
  await expect(page.getByRole("row", { name: new RegExp(`AV-OK-${tag}`) })).toContainText("Available");

  await page.goto(`/dispatch/resources?date=${today}&q=AV-&show=available`);
  await expect(page.getByRole("row", { name: new RegExp(`AV-OK-${tag}`) })).toBeVisible();
  await expect(page.getByRole("row", { name: new RegExp(`AV-SHOP-${tag}`) })).toHaveCount(0);
  await expect(page.getByRole("row", { name: new RegExp(`AV-SAFE-${tag}`) })).toHaveCount(0);

  // Drivers: hours of service are never shown as verified.
  await page.goto(`/dispatch/resources?date=${today}`);
  await expect(page.getByText("Not verified").first()).toBeVisible();
  await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);

  // The Smart Dispatch panel states the same limits.
  await page.goto("/dispatch");
  await expect(page.getByLabel("Limits of these proposals")).toContainText("Hours of service are not checked");
});

test("drivers and other companies cannot use dispatch availability", async ({ page, browser }) => {
  const unit = `AV-PRIV-${unique()}`;
  await asUser(USERS.owner.email, (q) => q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump')", [unit]));
  await signIn(page, "driver");
  await page.goto("/dispatch/resources");
  await expect(page).toHaveURL(/\/no-access/);

  const other = await browser.newPage();
  await signIn(other, "otherOwner");
  await other.goto(`/dispatch/resources?q=${unit}`);
  await expect(other.getByRole("heading", { name: "Driver & truck availability", level: 1 })).toBeVisible();
  await expect(other.getByText(unit)).toHaveCount(0);
  await other.close();
});
