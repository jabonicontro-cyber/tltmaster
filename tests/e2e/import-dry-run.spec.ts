import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signIn, unique } from "./helpers";

// Import dry run for Top Line's files (LR3, 2026-11-14): the fictional spreadsheets in tests/fixtures/import/ uploaded
// through Settings → Import as the owner would on import day. The preview reads Excel's exports (BOM, Windows line
// ends, a title row, blank rows, Windows encoding), shows spreadsheet row numbers and plain-word problems; nothing is
// created until the review is approved; contacts are matched to the customers just imported; undo leaves them inactive.

const FIXTURES = join(__dirname, "../fixtures/import");
/** A fixture with its names and emails made unique for this run, saved back the way it came (UTF-8 with BOM). */
const fixture = (name: string, id: string) =>
  Buffer.from(
    `﻿${readFileSync(join(FIXTURES, name), "utf8").replace(/^﻿/, "").replaceAll("(test)", `(test ${id})`).replace(/@([a-z.-]+)\.test/gi, `@$1-${id}.test`)}`,
    "utf8",
  );

async function upload(page: Page, entity: string, name: string, buffer: Buffer) {
  await page.goto("/settings?tab=import");
  await page.getByLabel("The spreadsheet contains").selectOption(entity);
  await page.getByLabel("Spreadsheet file (CSV)").setInputFiles({ name, mimeType: "text/csv", buffer });
}

test("an owner imports a messy customer list and its contacts, reviews, approves and undoes", async ({ page }) => {
  test.slow();
  const id = unique();
  await signIn(page, "owner");

  await upload(page, "customers", "customers.csv", fixture("customers.csv", id));
  await expect(page.getByText(/Skipped 2 rows above the column names: “Customer List \(test \w+\)”, “Printed 11\/3\/2026”\. The column names are on row 4\./)).toBeVisible();
  await expect(page.getByLabel("Field for column Cust Name")).toHaveValue("name");
  await expect(page.getByLabel("Field for column Phone #")).toHaveValue("phone");
  await expect(page.getByLabel("Field for column Acct #")).toHaveValue("");
  await expect(page.getByText("Not imported: Contact, Fax, Acct #.")).toBeVisible();
  await expect(page.getByText(/8\s*rows · 5\s*pass the first checks · 3\s*need fixing/)).toBeVisible();
  await expect(page.getByText("Not in this file, so every record gets: Type: Commercial.")).toBeVisible();
  const preview = page.getByRole("table", { name: "Preview" }).locator("tbody tr");
  await expect(preview).toHaveCount(8);
  await expect(preview.nth(0)).toContainText("5");
  await expect(preview.nth(0)).toContainText("(219) 555-0101");
  await expect(preview.nth(1).locator("td").nth(7)).toHaveText("IN"); // the file says "Indiana"
  await expect(preview.nth(2)).toContainText("Email has more than one address");
  await expect(preview.nth(4)).toContainText("has only 4 digits: Excel probably dropped a leading zero");
  await expect(preview.nth(5)).toContainText("shows a spreadsheet error (#N/A)");

  await page.getByRole("button", { name: "Check and send to review" }).click();
  await expect(page).toHaveURL(/\/settings\/import\/[0-9a-f-]{36}/);
  await expect(page.getByText("Nothing has been created yet")).toBeVisible();
  const rows = page.getByRole("table", { name: "Rows" }).locator("tbody tr");
  await expect(rows).toHaveCount(8);
  // Rows keep their spreadsheet numbers: row 9 repeats row 5 in lower case.
  await expect(rows.nth(3).locator("td").first()).toHaveText("9");
  await expect(rows.nth(3)).toContainText(`gravel gulch paving (test ${id})`);
  await expect(rows.nth(3)).toContainText("Possible duplicate");
  await expect(rows.nth(3)).toContainText("Same as row 5 of this file.");
  await expect(rows.nth(0)).toContainText("Yes"); // PO required, in words
  await page.getByLabel("I reviewed the rows and the decisions above.").check();
  await page.getByRole("button", { name: "Approve and create 4" }).click();
  await expect(page.getByText("Approved. The records now exist in your company.")).toBeVisible();
  const customersBatch = page.url();

  // The contacts file: first and last names joined, matched to the customers just created.
  await upload(page, "contacts", "contacts.csv", fixture("contacts.csv", id));
  await expect(page.getByText("Each contact is matched to a customer by name: import and approve the customers first.")).toBeVisible();
  await expect(page.getByLabel("Field for column First Name")).toHaveValue("name_first");
  await expect(page.getByRole("table", { name: "Preview" })).toContainText("Dana Fictional");
  await page.getByRole("button", { name: "Check and send to review" }).click();
  await expect(page).toHaveURL(/\/settings\/import\/[0-9a-f-]{36}/);
  const contactRows = page.getByRole("table", { name: "Rows" }).locator("tbody tr");
  await expect(contactRows.filter({ hasText: `Unknown Customer (test ${id})` })).toContainText("No customer with this name");
  await page.getByLabel("I reviewed the rows and the decisions above.").check();
  await page.getByRole("button", { name: "Approve and create 3" }).click();
  await expect(page.getByText("Approved. The records now exist in your company.")).toBeVisible();

  // Undo both: the records become inactive, never deleted.
  for (const url of [page.url(), customersBatch]) {
    await page.goto(url);
    await page.getByLabel("Reason").fill("Import dry run (test)");
    await page.getByRole("button", { name: "Undo import" }).click();
    await expect(page.getByText(/Undone\. The records this import created are now inactive/)).toBeVisible();
  }
});

test("the preview reads Excel's Windows encoding, joins driver names, shows dates in words and refuses workbooks", async ({ page }) => {
  test.slow();
  await signIn(page, "owner");
  await upload(page, "customers", "customers-windows1252.csv", readFileSync(join(FIXTURES, "customers-windows1252.csv")));
  const preview = page.getByRole("table", { name: "Preview" });
  await expect(preview).toContainText("Café Fictitious Concrete (test)");
  await expect(preview).toContainText("O’Malley Make-Believe Excavating (test)");

  await upload(page, "drivers", "drivers.csv", readFileSync(join(FIXTURES, "drivers.csv")));
  const rows = page.getByRole("table", { name: "Preview" }).locator("tbody tr");
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(0)).toContainText("Alex Testdriver (test)");
  await expect(rows.nth(0)).toContainText("May 1, 1998");
  await expect(rows.nth(0)).toContainText("Class A");
  await expect(rows.nth(1)).toContainText("is an Excel date number, not a date");
  await expect(rows.nth(5)).toContainText("8"); // row 7 of the spreadsheet is blank
  await expect(page.getByText("Not imported: CDL #, Status.")).toBeVisible();

  await page.getByLabel("Spreadsheet file (CSV)").setInputFiles({ name: "drivers.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("PK\u0003\u0004") });
  await expect(page.getByText("Save the spreadsheet as CSV first (in Excel: File → Save As → CSV UTF-8), then choose the CSV file.")).toBeVisible();
});
