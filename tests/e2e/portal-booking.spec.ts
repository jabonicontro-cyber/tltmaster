import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";
import { TOP_LINE_SLUG } from "./users";

// Customer self-booking (B115, 20261120005500), end to end: booking is off until the owner turns it on; dispatch opens
// loads on a day; a signed-in customer requests loads there (full days cannot be chosen) and sees it waiting; dispatch
// approves it and the customer sees "Approved". Nothing is scheduled by the request itself. Fictional people only.

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
  await sql("update public.booking_settings set enabled = false where company_id = $1", [TOP_LINE]);
});

test.afterEach(async () => {
  await sql("update public.portal_accounts set status = 'revoked', revoked_at = now() where company_id = $1 and email like 'e2e-bk-%' and status <> 'revoked'", [TOP_LINE]);
  await sql("update public.booking_settings set enabled = false where company_id = $1", [TOP_LINE]);
  await sql("update public.portal_settings set enabled = false where company_id = $1", [TOP_LINE]);
  await sql("delete from private.portal_entitlements where company_id = $1", [TOP_LINE]);
});

test("the owner turns booking on, dispatch opens a day, a customer requests loads and dispatch approves", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const username = `e2e-bk-${unique()}`;
  const material = `Base rock ${unique()}`;

  // A customer sign-in, created by staff (the provisioning flow is tested on its own).
  await signIn(page, "owner");
  await page.goto("/customer-portal?tab=access");
  await page.locator("#signin_customer").selectOption({ label: CUSTOMER });
  await page.getByLabel("Person's name").fill(`E2E Booking Contact ${unique()}`);
  await page.getByLabel("Username").fill(username);
  await expect(page.getByText(`${username} is available`)).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create Sign-in" }).click();
  const panel = page.getByRole("region", { name: "Sign-in instructions" });
  await panel.getByRole("button", { name: "Show", exact: true }).click();
  const temp = (await panel.getByText(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/).textContent())!.trim();
  await panel.getByRole("button", { name: "Done" }).click();

  // Booking is off by default: the tab says so.
  await page.goto("/customer-portal?tab=booking");
  await expect(page.getByText("Customer booking is off")).toBeVisible();
  await page.getByLabel("Customers can request loads in the portal").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Customer booking is on.")).toBeVisible();

  // Open 4 loads on the first bookable day (tomorrow); clear any earlier run's requests there.
  const day = (await sql<{ d: string }>("select (private.company_today($1) + 1)::text d", [TOP_LINE]))[0].d;
  await sql("update public.booking_requests set status = 'canceled' where company_id = $1 and day = $2 and status = 'pending'", [TOP_LINE, day]);
  const used = (await sql<{ n: number }>("select coalesce(sum(loads), 0)::int n from public.booking_requests where company_id = $1 and day = $2 and status = 'approved'", [TOP_LINE, day]))[0].n;
  await page.reload();
  await page.locator(`#cap-${day}`).fill(String(used + 4));
  await page.getByRole("button", { name: "Save open loads" }).click();
  await expect(page.getByText("Open loads saved.")).toBeVisible();

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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

    await cust.getByRole("link", { name: "Book loads" }).click();
    await expect(cust.getByRole("heading", { name: "Book loads" })).toBeVisible();
    const form = cust.getByRole("form", { name: "Book loads" });
    await form.getByLabel("Day").selectOption(day);
    // More loads than the day has room for is refused, without saying how many are left.
    await form.getByLabel("Loads").fill("5");
    await form.getByLabel("What do you need hauled?").fill(material);
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(cust.getByText(/does not have room for that many loads/)).toBeVisible();
    await form.getByLabel("Loads").fill("4");
    await form.getByLabel("What do you need hauled?").fill(material);
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(cust.getByText("Request sent.", { exact: false })).toBeVisible();
    const mine = cust.getByRole("list", { name: "Your booking requests" }).locator("li", { hasText: material });
    await expect(mine.getByText("Waiting for dispatch")).toBeVisible();
    // The day is now full: it cannot be chosen again.
    await cust.reload();
    await expect(cust.locator(`#bk-day option[value="${day}"]`)).toBeDisabled();

    // Dispatch sees it waiting and approves it.
    await page.reload();
    const waiting = page.getByRole("list", { name: "Booking requests waiting" }).locator("li", { hasText: material });
    await expect(waiting.getByText(CUSTOMER)).toBeVisible();
    await waiting.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Saved. The customer sees it in the portal.")).toBeVisible();

    await cust.reload();
    await expect(cust.getByRole("list", { name: "Your booking requests" }).locator("li", { hasText: material }).getByText("Approved")).toBeVisible();
  } finally {
    await ctx.close();
  }
});
