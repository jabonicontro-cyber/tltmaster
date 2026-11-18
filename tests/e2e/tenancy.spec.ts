import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { signIn } from "./helpers";
import { OTHER_COMPANY } from "./users";

// A second company must not see or reach any Top Line record through pages,
// server actions or the PDF route.

/** A sample customer of Top Line's seed (supabase/seed.sql). */
const TOP_LINE_CUSTOMER = "Prairie View Landscaping";

/** The record id in a link such as /customers/<id>?back=… */
const idOf = (href: string) => href.split(/[/?#]/)[2];

/** The record ids a list page links to (its table rows). */
async function recordIds(page: Page, kind: "customers" | "quotes") {
  const hrefs = await page.locator(`tbody a[href^='/${kind}/']`).evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
  return [...new Set(hrefs.map(idOf).filter((id) => /^[0-9a-f-]{36}$/.test(id)))];
}

/** The companies (by slug) that own these records, read straight from the database. */
async function companiesOf(table: "customers" | "quotes", ids: string[]) {
  if (!ids.length) return [];
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    const r = await c.query<{ id: string; slug: string }>(
      `select t.id, co.slug from public.${table} t join public.companies co on co.id = t.company_id where t.id = any($1::uuid[])`, [ids]);
    expect(r.rowCount, "every listed record is found").toBe(ids.length);
    return [...new Set(r.rows.map((x) => x.slug))].sort();
  } finally {
    await c.end();
  }
}

test("another company sees none of Top Line's records and cannot open them by URL", async ({ page, browser }) => {
  // Find a Top Line quote and customer as a Top Line user.
  const tl = await browser.newPage();
  await signIn(tl, "office");
  await tl.goto("/customers");
  const customerHref = await tl.locator("tbody a[href^='/customers/']").first().getAttribute("href");
  await tl.goto("/quotes");
  const quoteHref = await tl.locator("tbody a[href^='/quotes/']").first().getAttribute("href");
  expect(customerHref).toBeTruthy();
  expect(quoteHref).toBeTruthy();
  await tl.goto(quoteHref!);
  const pdfHref = await tl.getByRole("link", { name: "PDF", exact: true }).first().getAttribute("href");
  expect((await tl.request.get(pdfHref!)).status()).toBe(200);
  await tl.close();

  await signIn(page, "otherOwner");
  await expect(page.getByRole("link", { name: /Brookside Aggregates \(e2e test\)\s?, home/ }).first()).toBeVisible(); // the workspace shows its own company

  // The lists show none of Top Line's records. Brookside may have records of its own (tests/e2e/modules.spec.ts runs
  // its presets there with its own customer and quote), so each record listed is checked to be Brookside's own.
  await page.goto("/customers");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const customers = await recordIds(page, "customers");
  expect(customers).not.toContain(idOf(customerHref!));
  expect(await companiesOf("customers", customers)).toEqual(customers.length ? [OTHER_COMPANY.slug] : []);
  await expect(page.getByText(TOP_LINE_CUSTOMER)).toHaveCount(0);
  await page.goto("/quotes");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const quotes = await recordIds(page, "quotes");
  expect(quotes).not.toContain(idOf(quoteHref!));
  expect(await companiesOf("quotes", quotes)).toEqual(quotes.length ? [OTHER_COMPANY.slug] : []);
  await page.goto("/materials");
  await expect(page.getByText("Gravel #53 limestone")).toHaveCount(0);

  await page.goto(customerHref!);
  await expect(page.getByText("Not found", { exact: true })).toBeVisible();
  await page.goto(quoteHref!);
  await expect(page.getByText("Not found", { exact: true })).toBeVisible();
  expect((await page.request.get(pdfHref!)).status()).toBe(404);

  // Settings show this company's own details only.
  await page.goto("/settings?tab=company");
  await expect(page.getByLabel("Company name")).toHaveValue("Brookside Aggregates (e2e test)");
  await page.goto("/settings?tab=users");
  await expect(page.getByText("e2e-office@toplinetest.example")).toHaveCount(0);
  await expect(page.getByText("e2e-brookside-owner@brooksidetest.example")).toBeVisible();
});
