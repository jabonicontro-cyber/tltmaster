import { expect, test } from "@playwright/test";
import { signIn, unique } from "./helpers";

// Company self-import (B106, migration 20261120004600): the owner stages a customer spreadsheet from Settings → Import,
// reviews the rows, approves, and undoes it; undone records stay as inactive. A dispatcher has no Import tab.

test("an owner imports customers from a spreadsheet, then undoes it", async ({ page }) => {
  test.slow();
  const id = unique();
  const csv = ["Customer,Email", `Alder Paving ${id},ops@alder.test`, `Birch Grading ${id},`, `alder paving ${id},`, `,nobody@x.test`].join("\r\n");

  await signIn(page, "owner");
  await page.goto("/settings?tab=import");
  await page.getByLabel("The spreadsheet contains").selectOption("customers");
  await page.getByLabel("Spreadsheet file (CSV)").setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByLabel("Field for column Customer")).toHaveValue("name");
  await page.getByRole("button", { name: "Check and send to review" }).click();

  await expect(page).toHaveURL(/\/settings\/import\/[0-9a-f-]{36}/);
  await expect(page.getByText("Nothing has been created yet")).toBeVisible();
  const rows = page.getByRole("table", { name: "Rows" }).locator("tbody tr");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Ready");
  await expect(rows.nth(2)).toContainText("Possible duplicate");
  await expect(rows.nth(3)).toContainText("Needs fixing");
  await page.getByLabel("I reviewed the rows and the decisions above.").check();
  await page.getByRole("button", { name: "Approve and create 2" }).click();
  await expect(page.getByText("Approved. The records now exist in your company.")).toBeVisible();
  await expect(rows.nth(0)).toContainText("Created");

  await page.getByLabel("Reason").fill("Wrong spreadsheet (test)");
  await page.getByRole("button", { name: "Undo import" }).click();
  await expect(page.getByText(/Undone\. The records this import created are now inactive/)).toBeVisible();
  await expect(rows.nth(0)).toContainText("Made inactive by undo");

  // The import is listed in Settings with its status.
  await page.goto("/settings?tab=import");
  await expect(page.getByRole("table", { name: "Imports" }).getByRole("row").filter({ hasText: "customers.csv" }).first()).toContainText("Undone");

  // A dispatcher cannot import.
  await page.context().clearCookies();
  await signIn(page, "dispatcher");
  await page.goto("/settings?tab=import");
  await expect(page.getByRole("navigation", { name: "Settings menu" }).getByRole("link", { name: "Import" })).toHaveCount(0);
});
