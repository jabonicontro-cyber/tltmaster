import { expect, test, type Page } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function addTruck(page: Page, unit: string, type: string, capacity?: { weight: string; unit: string }) {
  await page.goto("/fleet/trucks/new");
  await page.getByLabel("Unit number").fill(unit);
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption({ label: type });
  if (capacity) {
    await page.getByLabel("Weight capacity (payload)").fill(capacity.weight);
    await page.getByLabel("Unit", { exact: true }).selectOption({ label: capacity.unit });
  }
  await page.getByRole("button", { name: "Add truck" }).click();
  await expect(page).toHaveURL(/\/fleet\/trucks\/[0-9a-f-]{36}(\?saved=1)?$/);
  await expect(page.getByRole("heading", { name: `Truck ${unit}` })).toBeVisible();
}

test("trucks: add with unknown capacity, verify capacity, take out of service with a reason and return", async ({ page }) => {
  const unit = `E2E-${unique()}`;
  await signIn(page, "office");
  await page.goto("/fleet");
  await expect(page.getByRole("navigation", { name: "Fleet sections" })).toBeVisible();

  await addTruck(page, unit, "Tri-axle dump");
  await expectToast(page, "Truck saved.");
  // Capacity was not entered: shown as unknown, never estimated.
  await expect(page.getByText("Unknown").first()).toBeVisible();

  // Unit numbers are unique in the company.
  await page.goto("/fleet/trucks/new");
  await page.getByLabel("Unit number").fill(unit.toLowerCase());
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption({ label: "Tandem-axle dump" });
  await page.getByRole("button", { name: "Add truck" }).click();
  await expect(page.getByText("Another truck already uses this unit number.").first()).toBeVisible();

  // Enter and verify a capacity.
  await page.goto(`/fleet/trucks?q=${unit}`);
  await page.getByRole("link", { name: unit }).click();
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await page.getByLabel("Weight capacity (payload)").fill("22.5");
  await page.getByLabel("Unit", { exact: true }).selectOption({ label: "Tons" });
  await page.getByLabel("Source").fill("Scale ticket (e2e)");
  await page.getByLabel("I have verified these capacities").check();
  await page.getByRole("button", { name: "Save truck" }).click();
  await expectToast(page, "Truck saved.");
  await expect(page.getByText("22.5 tons").first()).toBeVisible();
  await expect(page.getByText("Verified", { exact: true }).first()).toBeVisible();

  // Out of service needs a reason.
  await page.getByRole("button", { name: "Take out of service" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Take out of service" }).click();
  await expect(dialog.getByText("Enter the reason it is out of service.").first()).toBeVisible();
  await dialog.getByLabel("Reason").fill("Brake repair (e2e)");
  await dialog.getByLabel("Expected back (optional)").fill(plusDays(3));
  await dialog.getByRole("button", { name: "Take out of service" }).click();
  await expectToast(page, "Marked out of service.");
  await expect(page.getByText("Out of service").first()).toBeVisible();
  const history = page.getByRole("list", { name: "Equipment history" });
  await expect(history.getByText("In service → Out of service")).toBeVisible();
  await expect(history.getByText(/Brake repair \(e2e\)/)).toBeVisible();

  await page.goto("/fleet/trucks?status=out_of_service");
  await expect(page.getByRole("link", { name: unit })).toBeVisible();
  await page.getByRole("link", { name: unit }).click();
  await page.getByRole("button", { name: "Return to service" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Return to service" }).click();
  await expectToast(page, "Returned to service.");
  await expect(page.getByRole("list", { name: "Equipment history" }).getByText("Out of service → In service")).toBeVisible();
});

test("trailers, drivers and qualifications drive eligibility", async ({ page }) => {
  const id = unique();
  const tractor = `TR-${id}`;
  const dump = `DMP-${id}`;
  const trailer = `TL-${id}`;
  const driver = `Jordan Example ${id}`;
  await signIn(page, "office");
  await addTruck(page, tractor, "Tractor (semi)", { weight: "50000", unit: "Pounds" });
  await addTruck(page, dump, "Quad-axle dump");

  // Trailer compatible with tractors, paired with the tractor.
  await page.goto("/fleet/trailers/new");
  await page.getByLabel("Unit number").fill(trailer);
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption({ label: "End dump" });
  await page.getByLabel("Body volume (cubic yards)").fill("24");
  await page.getByLabel("Tractor (semi)").check();
  await page.getByLabel("Usually paired with truck").selectOption({ label: tractor });
  await page.getByRole("button", { name: "Add trailer" }).click();
  await expect(page.getByRole("heading", { name: `Trailer ${trailer}` })).toBeVisible();
  await expect(page.getByText("24 cu yd").first()).toBeVisible();
  await expect(page.getByText("Not verified").first()).toBeVisible();

  // Driver without qualifications is not eligible.
  await page.goto("/fleet/drivers/new");
  await page.getByLabel("Name").fill(driver);
  await page.getByLabel("Employee number").fill(`E${id}`);
  await page.getByRole("button", { name: "Add driver" }).click();
  await expect(page.getByRole("heading", { name: driver })).toBeVisible();
  await expect(page.getByText("No CDL is recorded for this driver.")).toBeVisible();

  // CDL class A, verified.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Class").selectOption("A");
  await dialog.getByLabel("Expires").fill(plusDays(700));
  await dialog.getByLabel(/I have seen the original document/).check();
  await dialog.getByRole("button", { name: "Add qualification" }).click();
  await expectToast(page, "Qualification added.");

  // Medical card not verified yet → still not eligible.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Type").selectOption({ label: "DOT medical card" });
  await dialog.getByLabel("Expires").fill(plusDays(10));
  await dialog.getByRole("button", { name: "Add qualification" }).click();
  await expectToast(page, "Qualification added.");
  await expect(page.getByText("Driver's medical card has not been verified.")).toBeVisible();

  // Verify it → eligible, with an expiry warning.
  await page.getByRole("button", { name: "Edit Medical card" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel(/I have seen the original document/).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expectToast(page, "Qualification updated.");
  await expect(page.getByText("Driver's medical card expires within 30 days.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Driver history" }).getByText("Qualification edited")).toBeVisible();

  // Combination checks on the overview.
  await page.goto("/fleet");
  await page.getByLabel("Truck", { exact: true }).selectOption({ label: `${tractor} — Tractor (semi)` });
  await page.getByLabel("Trailer", { exact: true }).selectOption({ label: `${trailer} — End dump` });
  await page.getByLabel("Driver", { exact: true }).selectOption({ label: driver });
  await page.getByRole("button", { name: "Check eligibility" }).click();
  const result = page.getByRole("status");
  await expect(result.getByText(/^Eligible on/)).toBeVisible();
  await expect(result.getByText("Truck capacity is recorded but not verified.")).toBeVisible();

  await page.getByLabel("Truck", { exact: true }).selectOption({ label: `${dump} — Quad-axle dump` });
  await page.getByRole("button", { name: "Check eligibility" }).click();
  await expect(result.getByText(/^Not eligible on/)).toBeVisible();
  await expect(result.getByText("This trailer is not recorded as compatible with this truck type.")).toBeVisible();

  // Trailer out of service independently of its truck.
  await page.goto(`/fleet/trailers?q=${trailer}`);
  await page.getByRole("link", { name: trailer }).click();
  await page.getByRole("button", { name: "Take out of service" }).click();
  await page.getByRole("dialog").getByLabel("Reason").fill("Tarp torn (e2e)");
  await page.getByRole("dialog").getByRole("button", { name: "Take out of service" }).click();
  await expectToast(page, "Marked out of service.");
  await page.getByRole("link", { name: `Truck ${tractor}` }).click();
  await expect(page.getByText("In service").first()).toBeVisible();
});

test("dispatchers view the fleet; mechanics change service status but cannot edit", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/fleet/trucks");
  await expect(page.getByRole("heading", { name: "Fleet", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add truck" })).toHaveCount(0);
  const first = page.locator("tbody a[href^='/fleet/trucks/']").first();
  await first.click();
  await expect(page.getByRole("button", { name: /out of service|Return to service/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);

  await page.context().clearCookies();
  await signIn(page, "mechanic");
  await page.goto("/fleet/trucks");
  await page.locator("tbody a[href^='/fleet/trucks/']").first().click();
  await expect(page.getByRole("button", { name: /Take out of service|Return to service/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Deactivate|Reactivate/ })).toHaveCount(0);
  await page.goto("/fleet/trucks/new");
  await expect(page).toHaveURL(/no-access/);
});
