import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";
import { TOP_LINE_SLUG } from "./users";

// Customer-portal username sign-ins (20261120001200; docs/ACCOUNT_PROVISIONING.md §4), end to end on the local stack:
// staff create a sign-in for a new contact of one customer; the customer signs in to the portal with the username and
// the temporary password, must choose their own password, and lands in their portal (never the company workspace);
// staff turn it off and the customer can no longer sign in, then turn it back on with a new temporary password.
// Fictional people only; nothing is emailed.

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
  await sql("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true", [TOP_LINE]);
});

// Audit history is append-only, so test sign-ins are kept and revoked rather than deleted.
test.afterEach(async () => {
  await sql("update public.portal_accounts set status = 'revoked', revoked_at = now() where company_id = $1 and email like 'e2e-pu-%' and status <> 'revoked'", [TOP_LINE]);
  await sql("update public.portal_settings set enabled = false where company_id = $1", [TOP_LINE]);
  await sql("delete from private.portal_entitlements where company_id = $1", [TOP_LINE]);
});

test("staff create a customer sign-in; the customer sets a password and lands in their portal; off and on again", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const person = `E2E Portal Contact ${unique()}`;
  const username = `e2e-pu-${unique()}`;

  await signIn(page, "owner");
  await page.goto("/customer-portal?tab=access");
  await page.locator("#signin_customer").selectOption({ label: CUSTOMER });
  await page.getByLabel("Person's name").fill(person);
  await page.getByLabel("Username").fill(username);
  await expect(page.getByText(`${username} is available`)).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText(`${person} (new contact)`)).toBeVisible();
  await page.getByRole("button", { name: "Create Sign-in" }).click();

  const panel = page.getByRole("region", { name: "Sign-in instructions" });
  await expect(panel.getByText(username)).toBeVisible();
  await panel.getByRole("button", { name: "Show", exact: true }).click();
  const temp = (await panel.getByText(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/).textContent())!.trim();
  await panel.getByRole("button", { name: "Print Sign-in Sheet" }).click();
  const sheet = page.getByRole("article", { name: "Sign-in sheet" });
  await expect(sheet.getByRole("heading", { name: "Your customer portal sign-in" })).toBeVisible();
  await expect(sheet.getByText(`/portal/${TOP_LINE_SLUG}/login`)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await panel.getByRole("button", { name: "Done" }).click();

  // One new contact, linked to exactly one customer; a second sign-in for the same contact is refused in the form.
  const contacts = await sql<{ n: number }>("select count(*)::int n from public.customer_contacts where company_id = $1 and name = $2", [TOP_LINE, person]);
  expect(contacts[0].n).toBe(1);

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const cust = await ctx.newPage();
  try {
    await cust.goto(`/portal/${TOP_LINE_SLUG}/login`);
    await cust.getByLabel("Email or username").fill(username);
    await cust.getByLabel("Password", { exact: true }).fill(temp);
    await cust.getByRole("button", { name: "Sign In" }).click();
    await cust.waitForURL(/\/welcome$/);
    // Nothing in the portal before setup.
    await cust.goto(`/portal/${TOP_LINE_SLUG}/orders`);
    await cust.waitForURL(/\/welcome$/);
    await cust.getByLabel("New password").fill("Quarry-Lane-2026!");
    await cust.getByLabel("Type it again").fill("Quarry-Lane-2026!");
    await cust.getByRole("button", { name: "Save My Password" }).click();
    await cust.waitForURL(new RegExp(`/portal/${TOP_LINE_SLUG}$`));
    // A portal sign-in never opens the company workspace.
    await cust.goto("/command-center");
    await expect(cust).not.toHaveURL(/\/command-center/);

    // Staff turn it off: the customer is refused at sign-in.
    await page.reload();
    const row = page.locator("li", { hasText: username }).first();
    await row.getByRole("button", { name: "Turn Off Sign-in" }).click();
    await row.getByRole("button", { name: "Turn Off", exact: true }).click();
    await expect(page.getByText(/Sign-in turned off|Portal access removed/).first()).toBeVisible();
    await ctx.clearCookies();
    await cust.goto(`/portal/${TOP_LINE_SLUG}/login`);
    await cust.getByLabel("Email or username").fill(username);
    await cust.getByLabel("Password", { exact: true }).fill("Quarry-Lane-2026!");
    await cust.getByRole("button", { name: "Sign In" }).click();
    await expect(cust.getByText(/turned off|incorrect/)).toBeVisible();

    // Turned back on: a new temporary password, the old one gone.
    await page.reload();
    await row.getByRole("button", { name: "Turn On Sign-in" }).click();
    const again = page.getByRole("region", { name: "Sign-in instructions" });
    await again.getByRole("button", { name: "Show", exact: true }).click();
    const temp2 = (await again.getByText(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/).textContent())!.trim();
    expect(temp2).not.toBe(temp);
    await cust.getByLabel("Password", { exact: true }).fill(temp2);
    await cust.getByRole("button", { name: "Sign In" }).click();
    await cust.waitForURL(/\/welcome$/);
  } finally {
    await ctx.close();
  }
});

test("people without customers.edit cannot create customer sign-ins", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/customer-portal?tab=access");
  await expect(page.getByRole("heading", { name: "Create a Customer Sign-in" })).toHaveCount(0);
});
