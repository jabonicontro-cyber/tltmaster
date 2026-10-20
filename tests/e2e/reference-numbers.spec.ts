import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers";

// Reference numbers (20261120001300; docs/REFERENCE_NUMBERS.md): a reference typed any reasonable way finds its
// record in global search and in the list, legacy references keep working, and another company's records stay hidden.

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

test("a reference typed without punctuation or in lower case finds the order; legacy numbers still work", async ({ page }) => {
  const [order] = await sql<{ id: string; order_number: string }>("select id, order_number from public.orders where company_id = $1 and status <> 'canceled' order by created_at desc limit 1", [TOP_LINE]);
  const typed = order.order_number.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  await signIn(page, "owner");
  await page.goto(`/search?q=${encodeURIComponent(typed)}`);
  await expect(page.getByRole("link", { name: new RegExp(`Order ${order.order_number}`) }).first()).toBeVisible();
  await page.goto(`/orders?q=${encodeURIComponent(typed)}`);
  await expect(page.getByRole("link", { name: order.order_number }).first()).toBeVisible();
  const [legacy] = await sql<{ order_number: string }>("select order_number from public.orders where company_id = $1 and order_number like 'O-%' limit 1", [TOP_LINE]);
  if (legacy) {
    await page.goto(`/search?q=${encodeURIComponent(legacy.order_number.replace(/-/g, " "))}`);
    await expect(page.getByRole("link", { name: new RegExp(`Order ${legacy.order_number}`) }).first()).toBeVisible();
  }
  // The detail page offers the reference to copy.
  await page.goto(`/orders/${order.id}`);
  await expect(page.getByRole("button", { name: `Copy order number ${order.order_number}` })).toBeVisible();
});

test("another company's references are not found", async ({ page }) => {
  const [mine] = await sql<{ order_number: string }>("select order_number from public.orders where company_id = $1 order by created_at desc limit 1", [TOP_LINE]);
  await signIn(page, "otherOwner");
  await page.goto(`/search?q=${encodeURIComponent(mine.order_number)}`);
  await expect(page.getByRole("link", { name: new RegExp(`Order ${mine.order_number}$`) })).toHaveCount(0);
});
