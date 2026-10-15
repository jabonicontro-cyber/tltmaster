import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";

// Site directions verification (master plan B51, migration 20261115000200): office staff mark a job site's directions
// verified, the verification shows who and when, and changing the directions clears it. Dispatchers (customers.view
// only) see the status but cannot verify. The owner sets the review intervals in Settings.

test("office staff verify a site's directions; changing them needs a new check", async ({ page, browser }) => {
  const name = `E2E Directions Customer ${unique()}`;
  await signIn(page, "office");
  await page.goto("/customers/new");
  await page.getByLabel("Customer name").fill(name);
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const customerUrl = page.url();

  await page.getByRole("button", { name: "Add job site" }).click();
  await page.getByLabel("Site name").fill("Low wire pit");
  await page.getByLabel("Street address").fill("9 Wire Rd (test)");
  await page.getByLabel("Directions / access notes").fill("Low power line over the back lot (test).");
  await page.getByLabel("How critical are these directions?").selectOption("safety_access");
  await page.getByRole("button", { name: "Save job site" }).click();
  await expectToast(page, "Job site added.");

  const sites = page.getByRole("list").filter({ hasText: "9 Wire Rd (test)" });
  await expect(sites.getByText("Safety or access critical")).toBeVisible();
  await expect(sites.getByText("Directions not verified")).toBeVisible();

  await sites.getByRole("button", { name: "Mark verified" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark verified" }).click();
  await expectToast(page, "Directions marked as verified today.");
  await expect(sites.getByText("Directions verified")).toBeVisible();
  await expect(sites.getByText(/Checked .* by Omar Office/)).toBeVisible();
  await expect(sites.getByRole("button", { name: "Mark verified" })).toHaveCount(0);

  // A dispatcher sees the status but cannot verify or edit.
  const ctx = await browser.newContext();
  const dispatch = await ctx.newPage();
  await signIn(dispatch, "dispatcher");
  await dispatch.goto(customerUrl);
  await expect(dispatch.getByText("Directions verified")).toBeVisible();
  await expect(dispatch.getByRole("button", { name: "Mark verified" })).toHaveCount(0);
  await ctx.close();

  // New directions clear the verification.
  await sites.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Directions / access notes").fill("Power line moved: dump at the front pad (test).");
  await page.getByRole("button", { name: "Save job site" }).click();
  await expectToast(page, "Job site updated.");
  await expect(sites.getByText("Directions not verified")).toBeVisible();
  await expect(sites.getByRole("button", { name: "Mark verified" })).toBeVisible();
});

test("the owner sets how often each kind of site is re-checked", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/settings");
  const standard = page.getByLabel("Standard sites: review every (days)");
  const safety = page.getByLabel("Safety or access critical: review every (days)");
  await expect(standard).toBeVisible();
  const before = [await standard.inputValue(), await safety.inputValue()];
  await safety.fill("0");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("At least 1 day.")).toBeVisible();
  await standard.fill("365");
  await safety.fill("90");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expectToast(page, /Company settings saved/);
  await page.reload();
  await expect(standard).toHaveValue("365");
  await expect(safety).toHaveValue("90");
  // Put the company back as it was (other tests share it).
  await standard.fill(before[0]);
  await safety.fill(before[1]);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expectToast(page, /Company settings saved/);
});
