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
  // The owner has billing access, so the receipt shows what it cost (SEC5).
  await expect(page.getByRole("list", { name: "Fuel purchases" }).locator("li", { hasText: unit })).toContainText("60.5 gal · $235.95");

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

// What fuel cost is money (owner 2026-11-12, SEC5, 20261120019800): a dispatcher and a mechanic see the receipt (state,
// gallons, odometer, vendor, receipt number) but not the amount; the owner and the office see it.
test("fuel receipt amounts show only to people with billing access", async ({ browser }) => {
  const id = unique();
  const unit = `FD-${id}`.slice(0, 20);
  // Yesterday (never in the future in the company's time zone), and that day's quarter.
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const q = `${day.slice(0, 4)}-${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;
  await asUser(USERS.owner.email, async (sql) => {
    const truck = (await sql("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
    await sql("select public.fuel_record_purchase($1::jsonb)", [JSON.stringify({ truck_id: truck, purchased_on: day, jurisdiction: "IA", gallons: "71.2", total_cents: 27768, odometer: 204512, vendor: "Fuel stop (test)", receipt_ref: `R-${id}` })]);
  });
  for (const who of ["dispatcher", "mechanic", "office", "owner"] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await signIn(page, who);
      await page.goto(`/fleet/fuel?q=${q}`);
      const row = page.getByRole("list", { name: "Fuel purchases" }).locator("li", { hasText: unit });
      await expect(row, who).toContainText("IA · 71.2 gal");
      await expect(row, who).toContainText("204,512 mi");
      await expect(row, who).toContainText(`Receipt R-${id}`);
      if (who === "owner" || who === "office") {
        await expect(row.getByTestId("fuel-amount"), who).toHaveText("$277.68");
      } else {
        await expect(row.getByTestId("fuel-amount"), who).toHaveCount(0);
        await expect(row, who).not.toContainText("$");
        await expect(page.getByText("Amounts paid are shown to people who can see billing."), who).toBeVisible();
      }
    } finally {
      await context.close();
    }
  }
});
