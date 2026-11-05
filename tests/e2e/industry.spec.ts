import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn } from "./helpers";
import { USERS } from "./users";

// Industry profile (master plan MK1): an owner says the company hauls general freight, and the delivery documents are
// called bills of lading in the menu and on their pages; back to aggregate, they are delivery tickets again.

test("the owner chooses what the company hauls and the words follow", async ({ page }) => {
  test.slow();
  const reset = () => asUser(USERS.owner.email, (q) => q("update public.company_settings set industry = 'aggregate' where company_id = (select private.current_company_id())"));
  await reset();
  try {
    await signIn(page, "owner");
    await page.goto("/settings?tab=company");
    const form = page.getByRole("form", { name: "What you haul" });
    await form.getByRole("radio", { name: /General freight/ }).check();
    await form.getByRole("button", { name: "Save" }).click();
    await expectToast(page, "Saved: General freight.");

    const menu = page.getByRole("navigation", { name: "Main" }).first();
    await expect(menu.getByRole("link", { name: "Bills of Lading" })).toBeVisible();
    await menu.getByRole("link", { name: "Bills of Lading" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Bills of Lading" })).toBeVisible();
    await expect(page).toHaveTitle(/Bills of Lading/);
    await expect(page.getByRole("link", { name: /Loads awaiting a BOL/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "All BOLs" })).toBeVisible();

    await page.goto("/settings?tab=company");
    await page.getByRole("form", { name: "What you haul" }).getByRole("radio", { name: /Aggregate and construction/ }).check();
    await page.getByRole("form", { name: "What you haul" }).getByRole("button", { name: "Save" }).click();
    await expectToast(page, "Saved: Aggregate and construction hauling.");
    await expect(page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Delivery Tickets" })).toBeVisible();
  } finally {
    await reset();
  }
});

test("people who can't manage settings see the choice but can't change it", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/settings?tab=company");
  const form = page.getByRole("form", { name: "What you haul" });
  if (await form.count()) {
    await expect(form.getByRole("radio").first()).toBeDisabled();
    await expect(form.getByRole("button", { name: "Save" })).toHaveCount(0);
  }
});
