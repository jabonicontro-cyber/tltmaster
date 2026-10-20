import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Contextual navigation: breadcrumbs return to the list view you came from
// (search and filters kept), phones get one "← Parent" link, and leaving a form
// with unsaved edits asks first.

test("the breadcrumb returns to the filtered list you came from; opened directly it goes to the plain list", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/customers?q=Prairie+View");
  // The view is recorded once the page is interactive; a click before that is a plain page load (nothing to remember).
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("taviron:list-view:/customers"))).toBe("/customers?q=Prairie+View");
  await page.getByRole("link", { name: /Prairie View Landscaping/ }).first().click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  const customerUrl = page.url();
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Customers" });
  await expect(crumb).toHaveAttribute("href", "/customers?q=Prairie+View");
  await crumb.click();
  await expect(page).toHaveURL(/\/customers\?q=Prairie\+View$/);

  // A fresh tab (bookmark or email link) has no remembered view: the plain list.
  const fresh = await page.context().newPage();
  await fresh.goto(customerUrl);
  await expect(fresh.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Customers" })).toHaveAttribute("href", "/customers");
  await fresh.close();
});

test("phones get a single back link instead of the breadcrumb trail", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signIn(page, "office");
  // Searched, so leftover test customers never push the seed customer off the first page.
  await page.goto("/customers?q=Prairie+View");
  await page.getByRole("link", { name: /Prairie View Landscaping/ }).first().click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeHidden();
  const back = page.getByRole("link", { name: "Customers", exact: true }).filter({ hasText: "Customers" }).last();
  await expect(back).toBeVisible();
  const box = await back.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44); // touch target
  await back.click();
  await expect(page).toHaveURL(/\/customers(\?q=Prairie\+View)?$/);
});

test("leaving a form with unsaved edits asks first; saving clears the warning", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/profile");
  await page.getByLabel("Name to show").fill("Unsaved Name");

  let asked = 0;
  page.on("dialog", (d) => { asked++; void d.dismiss(); });
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Orders" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  expect(asked).toBe(1);

  // After a successful save the same link navigates without asking. The person moves back to the form first (the
  // pointer leaving the sidebar lets the rail close, as it does for a real mouse).
  await page.mouse.move(1100, 500);
  await expect(page.getByRole("complementary", { name: "Sidebar" })).toHaveAttribute("data-expanded", "false");
  await page.getByLabel("Name to show").fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  await page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Orders" }).click();
  await expect(page).toHaveURL(/\/orders/);
  expect(asked).toBe(1);
});
