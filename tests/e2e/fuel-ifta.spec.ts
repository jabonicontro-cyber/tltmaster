// Fuel and IFTA (B130), end to end: the office records a trip sheet that crosses a state line and a fuel purchase on
// Fleet → Fuel and IFTA; the quarter's summary shows miles and gallons per state; the CSV downloads; a wrong entry is
// voided with a reason. Fictional records only.
import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

test("the office records a trip sheet and fuel, sees the IFTA summary and downloads it", async ({ page }) => {
  const id = unique();
  const unit = `FU-${id}`.slice(0, 20);
  await asUser(USERS.owner.email, (q) => q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump')", [unit]));

  await signIn(page, "owner");
  await page.goto("/fleet/fuel");
  await expect(page.getByRole("heading", { name: /IFTA summary/ })).toBeVisible();

  const trip = page.getByRole("form", { name: "Trip sheet" });
  await trip.getByLabel("Truck").selectOption({ label: unit });
  await trip.getByLabel("Odometer at start").fill("10000");
  await trip.getByLabel("Odometer at end").fill("10180");
  await trip.locator("#trip-state-0").selectOption("IA");
  await trip.getByRole("button", { name: "Crossed into another state" }).click();
  await trip.locator("#trip-state-1").selectOption("NE");
  await trip.getByLabel(/^Miles in IA/).fill("100");
  await trip.getByLabel(/^Miles in NE/).fill("70");
  await trip.getByRole("button", { name: "Save trip sheet" }).click();
  await expect(page.getByText(/must add up to the odometer difference \(180\)/)).toBeVisible();
  await trip.getByLabel(/^Miles in NE/).fill("80");
  await trip.getByRole("button", { name: "Save trip sheet" }).click();
  await expectToast(page, "Trip sheet saved.");

  const fuel = page.getByRole("form", { name: "Record fuel" });
  await fuel.getByLabel("Truck").selectOption({ label: unit });
  await fuel.locator("#fuel-state").selectOption("NE");
  await fuel.getByLabel("Gallons").fill("60.5");
  await fuel.getByLabel("Total ($)").fill("235.95");
  await fuel.getByRole("button", { name: "Save fuel" }).click();
  await expectToast(page, "Fuel recorded.");

  const sheets = page.getByRole("list", { name: "Trip sheets" }).locator("li", { hasText: unit });
  await expect(sheets).toContainText("180 mi · IA 100, NE 80");
  const summary = page.getByRole("table", { name: "IFTA summary" });
  await expect(summary.getByRole("row", { name: /^NE/ })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download IFTA summary (CSV)" }).click();
  const csv = await (await download).path();
  expect(csv).toBeTruthy();

  // A wrong entry is voided with a reason and stays listed as void.
  page.once("dialog", (d) => d.accept("Odometer typo (test)"));
  await sheets.getByRole("button", { name: "Void" }).click();
  await expectToast(page, "Voided.");
  await expect(page.getByRole("list", { name: "Trip sheets" }).locator("li", { hasText: unit })).toContainText("Void: Odometer typo (test)");
});
