// Digital inspections (B132), end to end on a phone: the driver's pre-trip on My Day with a minor defect opens a work
// order (the truck keeps running); the post-trip with a brake defect takes the truck out of service; the office sees
// both on Fleet → Inspections. Fictional records only.
import { expect, test } from "@playwright/test";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test("a driver records a pre-trip and a post-trip; defects reach the shop and the office", async ({ page, browser }) => {
  const f = await driverFixture();
  await signIn(page, "driver");
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pre-trip inspection" })).toBeVisible();

  const form = page.getByRole("form", { name: "Vehicle inspection" });
  const truck = form.getByLabel("Truck");
  if (await truck.count()) await truck.selectOption({ label: `Truck ${f.myTruck}` });
  await form.getByRole("button", { name: "Save inspection" }).click();
  await expect(form.getByText(/Mark every item OK or Defect \(11 left\)/)).toBeVisible();
  await form.getByRole("group", { name: "Windshield wipers" }).getByRole("button", { name: "Defect" }).click();
  await form.getByLabel("What is wrong with windshield wipers").fill("Driver-side blade streaking (test)");
  await form.getByRole("button", { name: "Mark the rest OK" }).click();
  await form.getByRole("button", { name: "Save inspection" }).click();
  await expectToast(page, "opened for the shop");

  // Post-trip: a brake defect is a safety defect and takes the truck out of service.
  await expect(page.getByRole("heading", { name: "Post-trip inspection" })).toBeVisible();
  await page.getByText("Start post-trip inspection").click();
  const post = page.getByRole("form", { name: "Vehicle inspection" });
  if (await post.getByLabel("Truck").count()) await post.getByLabel("Truck").selectOption({ label: `Truck ${f.myTruck}` });
  await post.getByRole("group", { name: "Service brakes" }).getByRole("button", { name: "Defect" }).click();
  await post.getByLabel("What is wrong with service brakes").fill("Air leak at the rear chamber (test)");
  await expect(post.getByText("A safety defect takes this truck out of service")).toBeVisible();
  await post.getByRole("button", { name: "Mark the rest OK" }).click();
  await post.getByRole("button", { name: "Save inspection" }).click();
  await expectToast(page, "out of service");

  // The office sees both inspections and the defects with their work orders.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const office = await ctx.newPage();
  await signIn(office, "office");
  await office.goto("/fleet/inspections");
  const defects = office.getByRole("list", { name: "Defects" }).locator("li", { hasText: f.myTruck });
  await expect(defects).toHaveCount(2);
  await expect(defects.filter({ hasText: "Air leak" })).toContainText("Safety");
  await expect(defects.filter({ hasText: "Windshield wipers" })).toContainText(/WO-/);
  await ctx.close();
});
