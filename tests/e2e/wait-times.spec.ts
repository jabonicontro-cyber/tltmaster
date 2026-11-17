import { expect, test } from "@playwright/test";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn } from "./helpers";

// Wait times (B111, migration 20261120005200; track only): on a phone, the driver taps Arrived and Left at the pickup
// and Arrived at the job site for today's load (undoing a wrong tap with Undo); a second tap is not offered; dispatch sees the pickup wait on Reports →
// Wait times. Nothing is billed. Fictional data only.

test.use({ viewport: { width: 390, height: 844 } });

test("a driver records arrival and departure; dispatch sees the wait", async ({ page, browser }) => {
  const f = await driverFixture();
  await signIn(page, "driver");
  const card = page.getByRole("listitem", { name: `Load 2, ${f.orderNumber}` });
  const pickup = card.getByRole("form", { name: "Pickup times" });
  const site = card.getByRole("form", { name: "Job site times" });
  await expect(pickup).toContainText("Not arrived");

  await pickup.getByRole("button", { name: "Record arrival at the pickup" }).click();
  await expectToast(page, /^Arrival at the pickup saved: \d/);
  await expect(pickup).toContainText(/Arrived \d/);
  await pickup.getByRole("button", { name: "Record departure from the pickup" }).click();
  await expectToast(page, /^Departure from the pickup saved: \d/);
  await expect(pickup).toContainText(/waited \d+ min/);
  await expect(pickup.getByRole("button")).toHaveCount(0);
  await site.getByRole("button", { name: "Record arrival at the job site" }).click();
  await expectToast(page, /^Arrival at the job site saved: \d/);
  await expect(site.getByRole("button", { name: "Record departure from the job site" })).toBeVisible();
  // A wrong tap is taken back with Undo on the confirmation (10 seconds; 20261120011000), then tapped again.
  await page.locator("[data-sonner-toast]").filter({ hasText: "Arrival at the job site saved" }).getByRole("button", { name: "Undo" }).click();
  await expectToast(page, "Arrived taken back.");
  await expect(site).toContainText("Not arrived");
  await site.getByRole("button", { name: "Record arrival at the job site" }).click();
  await expectToast(page, /^Arrival at the job site saved: \d/);
  await expect(site.getByRole("button", { name: "Record departure from the job site" })).toBeVisible();

  const office = await browser.newPage();
  await signIn(office, "dispatcher");
  await office.goto("/reports/wait-times?days=7");
  await expect(office.getByRole("heading", { name: "Wait times" })).toBeVisible();
  await expect(office.getByRole("table", { name: "Wait by place" })).toContainText("Pickup");
  await office.close();
});
