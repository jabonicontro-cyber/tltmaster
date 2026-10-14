import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Fleet management: documents with expiry, driver assignment with history, and
// maintenance restrictions shown (never bypassed) in Fleet. Fictional data only.

async function newTruck(unit: string) {
  return asUser(USERS.owner.email, async (q) =>
    (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string);
}

test("an expired registration is flagged on the profile, the directory filter and the overview", async ({ page }) => {
  const unit = `FD-${unique()}`;
  const id = await newTruck(unit);
  await signIn(page, "owner");
  await page.goto(`/fleet/trucks/${id}`);
  await expect(page.getByText("Registration not recorded.")).toBeVisible(); // missing is shown as missing

  await page.getByText("Add a document").click();
  await page.getByLabel("Document").selectOption("registration");
  await page.getByLabel("Number").fill("REG-778");
  await page.getByLabel("Issued on").fill("2025-11-01");
  await page.getByLabel("Expires on").fill("2025-10-01");
  await page.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByText("Must be on or after the issue date.")).toBeVisible(); // invalid dates explained
  await page.getByLabel("Issued on").fill("2024-10-01");
  await page.getByRole("button", { name: "Add document" }).click();
  await expectToast(page, "Document added.");
  await expect(page.getByText(/Registration expired/)).toBeVisible();
  await expect(page.getByText(/^Expired /)).toBeVisible();

  await page.goto(`/fleet/trucks?documents=expired&q=${unit}`);
  await expect(page.getByRole("link", { name: unit })).toBeVisible();
  await page.goto("/fleet");
  // Long lists show their first rows; the rest is one click away (CappedList).
  const docs = page.locator("details", { has: page.locator(`a:text-is("Truck ${unit}")`) });
  if (await docs.count()) await docs.first().locator("summary").click();
  await expect(page.getByRole("link", { name: `Truck ${unit}` })).toBeVisible();

  // Ownership is recorded separately and shown in the details.
  await page.goto(`/fleet/trucks/${id}`);
  await page.getByRole("combobox", { name: "Ownership" }).selectOption("leased");
  await page.getByRole("button", { name: "Save ownership" }).click();
  await expectToast(page, "Ownership saved.");
});

test("a dispatcher assigns and reassigns a truck's driver; history is kept and other screens follow", async ({ page }) => {
  const tag = unique();
  const unit = `FA-${tag}`;
  const id = await newTruck(unit);
  await asUser(USERS.owner.email, async (q) => {
    await q("insert into public.drivers (name) values ($1), ($2)", [`Avery ${tag}`, `Blake ${tag}`]);
  });

  await signIn(page, "dispatcher");
  await page.goto(`/fleet/trucks/${id}`);
  await expect(page.getByText("Add a document")).toHaveCount(0); // dispatchers read documents but do not edit them
  await page.getByLabel("Assign a driver").selectOption({ label: `Avery ${tag}` });
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expectToast(page, "Driver assigned.");
  await expect(page.getByRole("link", { name: `Avery ${tag}` })).toBeVisible();

  await page.getByLabel("Reassign to").selectOption({ label: `Blake ${tag}` });
  await page.getByRole("button", { name: "Reassign" }).click();
  await expectToast(page, "Driver assigned.");
  const history = page.locator("li", { hasText: tag });
  await expect(history.filter({ hasText: `Avery ${tag} removed` })).toBeVisible();
  await expect(history.filter({ hasText: `Blake ${tag} assigned` })).toBeVisible();

  await page.goto(`/fleet/trucks?q=${unit}&driver=assigned`);
  await expect(page.getByRole("row", { name: new RegExp(unit) })).toContainText(`Blake ${tag}`);

  page.once("dialog", (d) => d.accept());
  await page.goto(`/fleet/trucks/${id}`);
  await page.getByRole("button", { name: "Remove driver" }).click();
  await expectToast(page, "Driver removed from this truck.");
  await expect(page.getByText("No driver assigned.")).toBeVisible();
});

test("a safety-restricted truck shows as restricted and cannot be returned to service from Fleet", async ({ page }) => {
  const unit = `FS-${unique()}`;
  const id = await newTruck(unit);
  await asUser(USERS.owner.email, (q) =>
    q("select public.maintenance_create_work_order($1::jsonb)", [JSON.stringify({ truck_id: id, title: "Brake line chafed", safety_critical: true })]));

  await signIn(page, "owner");
  await page.goto(`/fleet/trucks/${id}`);
  await expect(page.getByText("Safety restricted").first()).toBeVisible();
  await expect(page.getByText("Not dispatch-ready.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to service" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Clearance in Maintenance" })).toBeVisible();

  await page.goto(`/fleet/trucks?maintenance=restricted&q=${unit}`);
  await expect(page.getByRole("link", { name: unit })).toBeVisible();
});

test("drivers and other companies cannot reach fleet records", async ({ page, browser }) => {
  const id = await newTruck(`FX-${unique()}`);
  await signIn(page, "driver");
  await page.goto("/fleet/trucks");
  await expect(page).toHaveURL(/\/no-access/);

  const other = await browser.newPage();
  await signIn(other, "otherOwner");
  await other.goto(`/fleet/trucks/${id}`);
  await expect(other.getByText("Not found", { exact: true })).toBeVisible();
  await other.close();
});
