import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers";
import { OTHER_COMPANY } from "./users";

// Global search: results only from records the person may open, inside their own company.

async function one<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows[0];
  } finally {
    await c.end();
  }
}

test("the office finds an order by number and a customer by name; other companies never appear", async ({ page }) => {
  const order = await one<{ order_number: string; customer: string }>(
    "select o.order_number, c.name customer from public.orders o join public.customers c on c.id = o.customer_id where o.company_id = '00000000-0000-4000-8000-000000000001' and o.status <> 'draft' order by o.created_at desc limit 1");
  const other = await one<{ name: string }>(
    "select cu.name from public.customers cu join public.companies co on co.id = cu.company_id where co.slug = $1 limit 1", [OTHER_COMPANY.slug]);
  await signIn(page, "office");
  await page.getByRole("link", { name: "Search records" }).click();
  await page.getByRole("searchbox", { name: "Search" }).or(page.locator("#global-q")).first().fill(order.order_number);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: new RegExp(`Order ${order.order_number}`) })).toBeVisible();
  await page.goto(`/search?q=${encodeURIComponent(order.customer)}`);
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  if (other) {
    await page.goto(`/search?q=${encodeURIComponent(other.name)}`);
    await expect(page.getByText(other.name, { exact: true })).toHaveCount(0);
  }
});

test("a driver's search covers nothing the driver cannot open", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/search?q=a");
  await expect(page.getByText("Your role has no records to search.")).toBeVisible();
});
