import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";
import { TOP_LINE_SLUG } from "./users";

// Customer portal Tickets page (20261120014000), end to end: a customer signed in on a phone opens Tickets from the
// portal menu, sees their own delivered tickets newest first with job site, material and quantity, filters by dates,
// downloads the filtered list as CSV and opens a ticket's customer copy. Another customer's ticket never appears, and
// the CSV route refuses a signed-out request. Fictional records only.

const CUSTOMER = "Prairie View Landscaping";
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

test.beforeEach(async () => {
  await sql("insert into private.portal_entitlements (company_id, entitled, note) values ($1, true, 'e2e') on conflict (company_id) do update set entitled = true", [TOP_LINE]);
  await sql("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true, feature_documents = true", [TOP_LINE]);
});

test.afterEach(async () => {
  await sql("update public.portal_accounts set status = 'revoked', revoked_at = now() where company_id = $1 and email like 'e2e-tix-%' and status <> 'revoked'", [TOP_LINE]);
  await sql("update public.portal_settings set enabled = false where company_id = $1", [TOP_LINE]);
  await sql("delete from private.portal_entitlements where company_id = $1", [TOP_LINE]);
});

test("a customer lists, filters and downloads their own delivery tickets and opens one", async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const username = `e2e-tix-${unique()}`;
  // The newest live ticket of this customer, and one of another customer (never shown).
  const mine = (await sql<{ id: string; ticket_number: string; order_id: string; day: string }>(
    `select t.id, t.ticket_number, t.order_id, (t.delivered_at at time zone coalesce(nullif(cs.timezone, ''), 'America/Chicago'))::date::text day
       from public.delivery_tickets t join public.orders o on o.id = t.order_id join public.customers c on c.id = o.customer_id
       left join public.company_settings cs on cs.company_id = t.company_id
      where t.company_id = $1 and c.name = $2 and o.status <> 'draft' and t.status in ('submitted', 'needs_review', 'accepted')
      order by t.delivered_at desc limit 1`, [TOP_LINE, CUSTOMER]))[0];
  test.skip(!mine, "The seed has no delivered ticket for the sample customer.");
  const others = await sql<{ ticket_number: string }>(
    `select t.ticket_number from public.delivery_tickets t join public.orders o on o.id = t.order_id join public.customers c on c.id = o.customer_id
      where t.company_id = $1 and c.name <> $2 and t.status in ('submitted', 'needs_review', 'accepted') limit 1`, [TOP_LINE, CUSTOMER]);

  // A customer sign-in, created by staff (provisioning is tested on its own).
  await signIn(page, "owner");
  await page.goto("/customer-portal?tab=access");
  await page.locator("#signin_customer").selectOption({ label: CUSTOMER });
  await page.getByLabel("Person's name").fill(`E2E Tickets Contact ${unique()}`);
  await page.getByLabel("Username").fill(username);
  await expect(page.getByText(`${username} is available`)).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create Sign-in" }).click();
  const panel = page.getByRole("region", { name: "Sign-in instructions" });
  await panel.getByRole("button", { name: "Show", exact: true }).click();
  const temp = (await panel.getByText(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/).textContent())!.trim();
  await panel.getByRole("button", { name: "Done" }).click();

  // Signed out: the CSV route gives no file.
  const anon = await request.get(`/portal/${TOP_LINE_SLUG}/tickets/csv`, { maxRedirects: 0 });
  expect(anon.status()).toBe(401);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const cust = await ctx.newPage();
  try {
    await cust.goto(`/portal/${TOP_LINE_SLUG}/login`);
    await cust.getByLabel("Email or username").fill(username);
    await cust.getByLabel("Password", { exact: true }).fill(temp);
    await cust.getByRole("button", { name: "Sign In" }).click();
    await cust.waitForURL(/\/welcome$/);
    await cust.getByLabel("New password").fill("Quarry-Lane-2026!");
    await cust.getByLabel("Type it again").fill("Quarry-Lane-2026!");
    await cust.getByRole("button", { name: "Save My Password" }).click();
    await cust.waitForURL(new RegExp(`/portal/${TOP_LINE_SLUG}$`));

    // Tickets is in the portal menu, in view on a phone.
    const tab = cust.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Tickets" });
    await expect(tab).toBeInViewport();
    await tab.click();
    await expect(cust.getByRole("heading", { name: "Delivery tickets" })).toBeVisible();
    const list = cust.getByLabel("Tickets");
    await expect(list.getByText(mine.ticket_number)).toBeVisible();
    if (others[0]) await expect(cust.getByText(others[0].ticket_number, { exact: true })).toHaveCount(0);
    // The main action and the download are glove-sized on a phone.
    const show = cust.getByRole("button", { name: "Show tickets" });
    expect((await show.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // Filter to the newest ticket's day: it stays, the summary counts what is shown.
    await cust.getByLabel("From").fill(mine.day);
    await cust.getByLabel("To").fill(mine.day);
    await show.click();
    await cust.waitForURL(new RegExp(`from=${mine.day}&to=${mine.day}`));
    await expect(list.getByText(mine.ticket_number)).toBeVisible();
    await expect(cust.getByTestId("tickets-summary")).toContainText(/\d+ tickets?/);

    // The CSV has exactly the filtered list.
    const [download] = await Promise.all([cust.waitForEvent("download"), cust.getByRole("link", { name: "Download CSV" }).click()]);
    expect(download.suggestedFilename()).toBe(`tickets-${mine.day}-to-${mine.day}.csv`);
    const text = (await (await import("node:fs/promises")).readFile((await download.path())!, "utf8")).replace(/^﻿/, "");
    expect(text.split("\r\n")[0]).toBe("Delivered,Ticket,Order,Job site,Project,PO,Material,Quantity,Unit,Status,Reference");
    expect(text).toContain(mine.ticket_number);
    if (others[0]) expect(text).not.toContain(others[0].ticket_number);

    // Opening a ticket shows the customer copy (the existing printable page).
    await list.getByText(mine.ticket_number).click();
    await cust.waitForURL(new RegExp(`/portal/${TOP_LINE_SLUG}/orders/${mine.order_id}/tickets/${mine.id}$`));
    await expect(cust.getByText("Delivery ticket")).toBeVisible();

    // A day without deliveries: the empty state says what to do.
    await cust.goto(`/portal/${TOP_LINE_SLUG}/tickets?from=2000-01-01&to=2000-01-02`);
    await expect(cust.getByText("No tickets for this filter")).toBeVisible();
    await expect(cust.getByRole("link", { name: "Clear the filter" })).toBeVisible();

    // Documents switched off by the company: no Tickets tab and the page is not available.
    await sql("update public.portal_settings set feature_documents = false where company_id = $1", [TOP_LINE]);
    await cust.goto(`/portal/${TOP_LINE_SLUG}`);
    await expect(cust.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Tickets" })).toHaveCount(0);
    expect((await cust.goto(`/portal/${TOP_LINE_SLUG}/tickets`))?.status()).toBe(404);
    expect((await cust.request.get(`/portal/${TOP_LINE_SLUG}/tickets/csv`)).status()).toBe(403);
  } finally {
    await sql("update public.portal_settings set feature_documents = true where company_id = $1", [TOP_LINE]);
    await ctx.close();
  }
});
