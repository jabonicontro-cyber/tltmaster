import { expect, test, type Locator, type Page } from "@playwright/test";
import { asUser } from "./db";
import { driverFixture } from "./driver-fixture";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

// One count per number (owner walkthrough WK1): a Command Center figure opens a page that shows the same count, and the
// trucks and drivers ready today read the same on the Command Center, Fleet and Maintenance. Local stack only.

/** The figure on a Command Center overview row (the last number in the row). */
async function figure(row: Locator): Promise<number> {
  const text = await row.innerText();
  const numbers = text.match(/\d+/g);
  expect(numbers, `a number in "${text}"`).not.toBeNull();
  return Number(numbers![numbers!.length - 1]);
}

const overviewRow = (page: Page, label: string) => page.getByRole("list", { name: "Overview" }).getByRole("listitem", { name: label, exact: true });

test("driver reports not resolved: the Command Center figure and Driver Reports show the same reports", async ({ page }) => {
  test.setTimeout(120_000);
  // Two reports from a driver: one stays open, one is acknowledged (still not resolved).
  const f = await driverFixture();
  const tag = unique();
  const ids = await asUser(USERS.driver.email, async (q) => {
    const send = async (description: string, key: string) =>
      ((await q("select public.driver_submit_field_report($1::jsonb) as r", [JSON.stringify({ assignment_id: f.late, kind: "equipment_issue", equipment: "truck", description, submission_key: key })])).rows[0].r as { report_id: string }).report_id;
    return [await send(`Mirror cracked ${tag}`, crypto.randomUUID()), await send(`Seat belt sticks ${tag}`, crypto.randomUUID())];
  });
  await asUser(USERS.owner.email, (q) => q("select public.review_field_report($1, 'acknowledge', 'Shop will look at it')", [ids[1]]));

  await signIn(page, "owner");
  await page.goto("/command-center");
  const row = overviewRow(page, "Driver reports not resolved");
  const n = await figure(row);
  expect(n).toBeGreaterThanOrEqual(2);
  await row.getByRole("link").click();
  await expect(page).toHaveURL(/\/field-reports\?view=unresolved$/);
  const tab = page.getByRole("navigation", { name: "Report views" }).getByRole("link", { name: /Not resolved/ });
  await expect(tab).toHaveAttribute("aria-current", "page");
  await expect(tab).toContainText(String(n));
  const list = page.getByRole("list", { name: "Driver reports" });
  await expect(list.getByText(`Mirror cracked ${tag}`)).toBeVisible();
  await expect(list.getByText(`Seat belt sticks ${tag}`)).toBeVisible();
  if (n <= 200) await expect(list.getByRole("listitem")).toHaveCount(n);
  // The default view of the page is the same list.
  await page.goto("/field-reports");
  await expect(page.getByRole("navigation", { name: "Report views" }).getByRole("link", { name: /Not resolved/ })).toHaveAttribute("aria-current", "page");
});

test("orders blocked from billing and missing tickets: the figures match the billing views they open", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner");
  await page.goto("/command-center");
  const blocked = await figure(overviewRow(page, "Orders blocked from billing"));
  const missing = await figure(overviewRow(page, "Missing delivery tickets"));

  await overviewRow(page, "Orders blocked from billing").getByRole("link").click();
  await expect(page).toHaveURL(/\/billing\?view=exceptions&readiness=blocked$/);
  await expect(page.getByTestId("blocked-only")).toContainText(`${blocked} ${blocked === 1 ? "order is" : "orders are"} blocked from billing`);
  if (blocked > 0) await expect(page.getByRole("list", { name: "Orders with exceptions" }).getByText("Blocked: exceptions")).toHaveCount(blocked);

  // Billing counts missing tickets like the Command Center: loads that ran without a ticket; loads that never got a
  // truck are named apart (Dispatch's).
  await page.goto("/billing?view=missing");
  const stage = page.getByRole("region", { name: "Billing pipeline" }).getByRole("link", { name: /Missing tickets/ });
  await expect(stage).toContainText(new RegExp(`Missing tickets\\s*${missing} loads?`));
  await expect(stage).toContainText("loads that ran without a ticket");
});

test("trucks and drivers ready today read the same on the Command Center, Fleet and Maintenance", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner");
  // The shared local database can gain a truck or driver from another run between two page loads: the pages are read
  // again until a quiet moment shows all three, so a real disagreement still fails.
  await expect(async () => {
    await page.goto("/command-center");
    const driversCc = await overviewRow(page, "Drivers ready today").innerText();
    const [ccReady, ccTotal] = [Number(driversCc.match(/(\d+)\s*$/)![1]), Number(driversCc.match(/of (\d+)/)![1])];
    await page.goto("/fleet");
    const ready = page.getByRole("region", { name: "Ready for work" });
    const drivers = await ready.getByRole("link", { name: /Drivers ready today/ }).innerText();
    expect(drivers).toMatch(new RegExp(`^${ccReady}\\s*of ${ccTotal}`));
    const trucks = await ready.getByRole("link", { name: /Trucks ready today/ }).innerText();
    const [fleetTrucks, fleetTotal] = trucks.match(/^(\d+)\s*of (\d+)/)!.slice(1).map(Number);
    await page.goto("/maintenance");
    expect(await page.getByRole("region", { name: "Overview" }).innerText()).toContain(`${fleetTotal} active truck${fleetTotal === 1 ? "" : "s"}`);
    expect(await page.getByRole("list", { name: "Truck availability" }).getByRole("link", { name: /^Available/ }).innerText()).toMatch(new RegExp(`Available\\s*${fleetTrucks}$`));
  }).toPass({ timeout: 60_000 });
});
