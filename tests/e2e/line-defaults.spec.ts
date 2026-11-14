import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

// Default units for new lines (master plan MK1): a custom hauling line starts in the unit the company's own hauling
// charges use (else what it hauls), with no rate filled in; other custom lines start in "each". Top Line hauls
// aggregate and prices hauling per ton and per load, so a custom hauling line starts in tons.

test.use({ deviceScaleFactor: 2 });

test("a custom hauling line on a new order starts in the company's own hauling unit, with no rate guessed", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/orders/new");
  await page.getByRole("combobox", { name: "Customer" }).click();
  await page.keyboard.type("Lakeshore");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Add hauling / charge" }).click();
  const line = page.getByRole("listitem", { name: "Line 1" });
  await line.getByLabel("Charge").selectOption({ label: "Custom: Hauling / delivery" });
  await expect(line.getByLabel("Unit")).toHaveValue("ton");
  await expect(line.getByLabel("Rate ($/ton)")).toHaveValue("");
  if (process.env.AI_OPTIN_SHOTS) await line.screenshot({ path: `${process.env.AI_OPTIN_SHOTS}/order-custom-hauling-line-unit.png` });

  // A custom surcharge (a fee, a truck ordered not used) stays "each".
  await page.getByRole("button", { name: "Add hauling / charge" }).click();
  const fee = page.getByRole("listitem", { name: "Line 2" });
  await fee.getByLabel("Charge").selectOption({ label: "Custom: Surcharge" });
  await expect(fee.getByLabel("Unit")).toHaveValue("each");
});

test("a new material in the catalog starts in the unit the company's materials use most", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/materials?tab=materials");
  await page.getByRole("button", { name: /Add material/ }).first().click();
  await expect(page.getByRole("dialog").getByLabel("Default unit")).toHaveValue("ton");
});
