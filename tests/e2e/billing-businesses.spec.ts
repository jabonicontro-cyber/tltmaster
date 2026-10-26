import { expect, test } from "@playwright/test";
import pg from "pg";
import { expectToast, signIn, unique } from "./helpers";

// Billing businesses and QuickBooks (B82, B89): the owner opens Businesses and QuickBooks from Billing, adds a second
// business and sends materials to it. QuickBooks keys are not set (owner: closer to launch), so the page shows it as
// coming soon instead of offering a connection that cannot work. The simulated demo send is covered in demo-parity.spec.ts.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

test("the owner adds a business and chooses which charges it bills", async ({ page }) => {
  const name = `E2E Stone ${unique()}`;
  try {
    await signIn(page, "owner");
    await page.goto("/billing");
    await page.getByRole("link", { name: "Businesses and QuickBooks" }).click();
    await expect(page.getByRole("heading", { name: "Businesses and QuickBooks", level: 1 })).toBeVisible();
    await expect(page.getByText("QuickBooks Online sync is switched on closer to launch.").first()).toBeVisible();

    await page.getByRole("button", { name: "Add a business" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await dialog.getByLabel("Invoice prefix").fill("ss");
    await dialog.getByRole("button", { name: "Save business" }).click();
    await expectToast(page, /saved/i);
    const card = page.locator("section, div").filter({ has: page.getByText(name, { exact: true }) }).first();
    await expect(card).toContainText("Invoice prefix SS");

    const split = page.getByLabel("Materials");
    await split.selectOption({ label: name });
    await page.getByRole("button", { name: "Save billing split" }).click();
    await expectToast(page, "Billing split saved.");
    await page.reload();
    await expect(page.getByLabel("Materials").locator("option:checked")).toHaveText(name);
  } finally {
    // Leave Top Line as other specs expect it: no businesses added by this run.
    const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
    try {
      await db.query("delete from public.billing_entity_rules where company_id = $1 and entity_id in (select id from public.billing_entities where company_id = $1 and name like 'E2E Stone %')", [TOP_LINE]);
      await db.query("delete from public.billing_entities where company_id = $1 and name like 'E2E Stone %'", [TOP_LINE]);
    } finally {
      await db.end();
    }
  }
});
