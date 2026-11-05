import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn } from "./helpers";
import { USERS } from "./users";

// Stops on an order (MK2 slice 1): in a company that hauls freight, the office lists a load's pickup and two
// deliveries with an appointment window and reference; the order page shows them in order, the dispatch board shows
// the route, and the assigned driver sees each stop with a way to navigate there. Removing them restores the job site.

const setIndustry = (industry: string) =>
  asUser(USERS.owner.email, (q) => q("update public.company_settings set industry = $1 where company_id = (select private.current_company_id())", [industry]));

test("the office lists stops and the driver and dispatcher see them", async ({ browser }) => {
  test.slow();
  const fx = await driverFixture();
  const today = (await asUser(USERS.office.email, (q) => q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d"))).rows[0].d as string;
  await setIndustry("freight");
  try {
    const office = await (await browser.newContext()).newPage();
    await signIn(office, "office");
    await office.goto(`/orders/${fx.orderId}`);
    await office.getByRole("button", { name: "Add stops" }).click();
    const form = office.getByRole("form", { name: "Edit stops" });
    await form.getByLabel("Shipper or place").first().fill("Acme Steel (e2e)");
    await form.getByLabel("City").nth(0).fill("Gary");
    await form.getByLabel("State").nth(0).fill("IN");
    await form.getByLabel("Appointment date").nth(0).fill(today);
    await form.getByLabel("Window from").nth(0).fill("07:00");
    await form.getByLabel("Window to").nth(0).fill("09:00");
    await form.getByLabel("Reference").nth(0).fill("PU-4411");
    await form.getByLabel("Receiver or place").first().fill("Lakeside Build (e2e)");
    await form.getByLabel("City").nth(1).fill("Joliet");
    await form.getByLabel("State").nth(1).fill("IL");
    await form.getByRole("button", { name: "Add delivery" }).click();
    await form.getByLabel("Receiver or place").nth(1).fill("Harbor Supply (e2e)");
    await form.getByLabel("Notes for the driver").nth(2).fill("Dock 3, call ahead");

    // The editor checks the order of stops before saving: a delivery can't come first.
    await form.getByRole("button", { name: "Move stop 2 up" }).click();
    await form.getByRole("button", { name: "Save stops" }).click();
    await expect(form.getByText("The first stop must be a pickup.")).toBeVisible();
    await form.getByRole("button", { name: "Move stop 1 down" }).click();
    await form.getByRole("button", { name: "Save stops" }).click();
    await expectToast(office, "Stops saved. Drivers see them on their load card.");

    const list = office.getByRole("list", { name: "Stops" });
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await expect(list.getByRole("listitem").nth(0)).toContainText("Acme Steel (e2e)");
    await expect(list.getByRole("listitem").nth(0)).toContainText("Ref PU-4411");
    await expect(list.getByRole("listitem").nth(0)).toContainText("7:00 AM – 9:00 AM");
    await expect(list.getByRole("listitem").nth(2)).toContainText("Dock 3, call ahead");
    await expect(office.getByText("1 pickup, 2 deliveries, in the order the truck makes them.")).toBeVisible();

    // The dispatch board shows the route instead of the job site.
    const dispatcher = await (await browser.newContext()).newPage();
    await signIn(dispatcher, "dispatcher");
    await dispatcher.goto(`/dispatch?date=${today}`);
    await expect(dispatcher.getByText("Gary, IN → Harbor Supply (e2e) (+1 stop)").first()).toBeVisible();

    // The assigned driver sees the stops in order with a Navigate link for each.
    const driver = await (await browser.newContext()).newPage();
    await signIn(driver, "driver");
    await driver.goto("/driver");
    const stops = driver.getByRole("list", { name: "Stops" }).first();
    await expect(stops.getByRole("listitem")).toHaveCount(3);
    await expect(stops.getByRole("listitem").first()).toContainText("Acme Steel (e2e)");
    await expect(stops.getByRole("link", { name: "Go to stop 1, Acme Steel (e2e)" })).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/dir\/.*Gary/);
    await expect(driver.getByRole("link", { name: "Navigate to site" })).toHaveCount(0);
    // Arrived and Left are recorded at each stop (MK2 slice 2), not just at the pickup and job site.
    await expect(driver.getByRole("form", { name: "Job site times" })).toHaveCount(0);
    const first = driver.getByRole("form", { name: "1. Acme Steel (e2e) times" }).first();
    await first.getByRole("button", { name: "Arrived" }).click();
    await expectToast(driver, "Arrived stop recorded.");
    await expect(first.getByText(/^Arrived \d/)).toBeVisible();
    await expect(driver.getByRole("form", { name: "2. Lakeside Build (e2e) times" }).first().getByRole("button", { name: "Arrived" })).toBeVisible();

    // Removing them all brings the job site back on the driver's card.
    await office.getByRole("button", { name: "Edit stops" }).click();
    await office.getByRole("button", { name: "Remove all stops" }).click();
    await expectToast(office, "Stops removed.");
    await driver.reload();
    await expect(driver.getByRole("list", { name: "Stops" })).toHaveCount(0);
  } finally {
    await setIndustry("aggregate");
    await asUser(USERS.office.email, (q) => q("select public.save_order_stops($1, '[]'::jsonb)", [fx.orderId])).catch(() => {});
  }
});

test("an aggregate company doesn't see an empty stops section", async ({ page }) => {
  const fx = await driverFixture();
  await signIn(page, "office");
  await page.goto(`/orders/${fx.orderId}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add stops" })).toHaveCount(0);
});
