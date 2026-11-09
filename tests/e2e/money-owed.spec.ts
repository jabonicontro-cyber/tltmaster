import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers";

// Command Center "Money owed" (owner first): people who see billing get open receivables, the overdue part and the
// oldest overdue invoice, read from the same issued invoices and payments as Billing → Invoices, linked to the overdue
// list. Roles without billing permission never see it.

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

test("the owner sees what is owed and overdue, and it opens the overdue invoices", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/command-center");
  const tile = page.getByText("Money owed", { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-panel')][1]");
  await expect(tile).toBeVisible();
  const issued = (await sql<{ n: number }>("select count(*)::int n from public.invoices where company_id = $1 and status = 'issued'", [TOP_LINE]))[0].n;
  if (!issued) {
    // Nothing invoiced yet: the tile says how invoices start, never a made-up $0.
    await expect(page.getByTestId("money-owed-empty")).toContainText(/No invoices yet: invoices appear here once orders are billed|issued in QuickBooks/);
    return;
  }
  const overdue = page.getByTestId("money-owed-overdue");
  if (await overdue.count()) {
    await expect(overdue).toContainText(/overdue on \d+ invoices?/);
    await expect(overdue).toContainText(/Oldest \d+ days? late/);
    await overdue.click();
    await page.waitForURL(/\/billing\/invoices\?view=overdue$/);
    await expect(page.getByRole("link", { name: /Overdue/ })).toHaveAttribute("aria-current", "page");
  } else {
    await expect(tile).toContainText(/nothing overdue|Every issued invoice is paid/);
  }
});

test("the office sees it too; a dispatcher, without billing permission, does not", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/command-center");
  await expect(page.getByText("Money owed", { exact: true })).toBeVisible();
  await page.context().clearCookies();
  await signIn(page, "dispatcher");
  await page.goto("/command-center");
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByText("Money owed", { exact: true })).toHaveCount(0);
});
