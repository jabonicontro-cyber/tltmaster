import { expect, test, type Browser } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";
import { latestMail } from "./mailbox";
import { TOP_LINE_SLUG } from "./users";

// Customer portal (20261120000700), end to end: the owner turns the portal on, invites a customer contact, the customer
// creates an account from the one-time link, follows orders, requests a quote (duplicates refused), asks a question and
// reads the office's reply. A customer account never reaches the company workspace.

const CUSTOMER = "Prairie View Landscaping";

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

test.beforeEach(async () => {
  // The platform owner's entitlement (tested in the DB suite); the company's own switch is turned on through the UI.
  await sql("insert into private.portal_entitlements (company_id, entitled, note) values ($1, true, 'e2e') on conflict (company_id) do update set entitled = true", [TOP_LINE]);
});

test.afterEach(async () => {
  await sql("update public.portal_settings set enabled = false, feature_tracking = false where company_id = $1", [TOP_LINE]);
  await sql("update public.portal_accounts set status = 'revoked', revoked_at = now(), invite_hash = null where company_id = $1 and email like 'e2e-portal-%' and status <> 'revoked'", [TOP_LINE]);
  await sql("delete from private.portal_entitlements where company_id = $1", [TOP_LINE]);
});

async function customerPage(browser: Browser) {
  const ctx = await browser.newContext();
  return { ctx, page: await ctx.newPage() };
}

test("owner opens the portal and invites a contact; the customer signs up, follows orders, requests a quote and gets an answer", async ({ page, browser }) => {
  const email = `e2e-portal-${unique()}@cust.example`;
  await signIn(page, "owner");
  await page.goto("/customer-portal?tab=settings");
  await expect(page.getByRole("heading", { name: "Customer Portal" })).toBeVisible();
  await page.getByLabel(/Portal on/).check();
  await page.getByLabel("Welcome message").fill("Welcome! Follow your loads here.");
  await page.getByRole("button", { name: "Save Portal Settings" }).click();
  await expect(page.getByText("Portal settings saved.")).toBeVisible();

  await page.goto("/customer-portal?tab=access");
  await page.getByLabel("Customer", { exact: true }).selectOption({ label: CUSTOMER });
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Create Invitation" }).click();
  const link = await page.getByLabel("Invitation link").inputValue();
  expect(link).toMatch(/\/portal\/accept\?token=[0-9a-f]{64}$/);
  await expect(page.getByText(email)).toBeVisible();

  // The customer, in their own browser.
  const { ctx, page: cust } = await customerPage(browser);
  try {
    await cust.goto(new URL(link).pathname + new URL(link).search);
    await expect(cust.getByText(CUSTOMER)).toBeVisible();
    // Holding the link is not enough to get an account: the address must prove it is theirs (security review F1).
    const sentAt = Date.now() - 1000;
    await cust.getByRole("button", { name: "Email Me a Sign-In Link" }).click();
    await expect(cust.getByRole("status")).toContainText(`We sent a sign-in link to ${email}`);
    const mail = await latestMail(email, sentAt);
    await cust.goto(mail.link.replace(/^https?:\/\/[^/]+/, ""));
    await cust.getByLabel("New password", { exact: true }).fill("Portal-Test-Passw0rd!");
    await cust.getByLabel("Confirm new password").fill("Portal-Test-Passw0rd!");
    await cust.getByRole("button", { name: "Save password" }).click();
    // Back to the invitation, now signed in as the invited address.
    await cust.waitForURL(/\/portal\/accept\?token=/);
    await cust.getByRole("button", { name: "Accept Invitation" }).click();
    await cust.waitForURL(new RegExp(`/portal/${TOP_LINE_SLUG}$`));
    await expect(cust.getByRole("heading", { name: `Welcome, ${CUSTOMER}` })).toBeVisible();
    await expect(cust.getByText("Welcome! Follow your loads here.")).toBeVisible();

    // The link works once.
    await cust.goto(new URL(link).pathname + new URL(link).search);
    await expect(cust.getByRole("heading", { name: "This invitation is not valid" })).toBeVisible();

    // Orders: only this customer's (the sample orders of the other customer never appear).
    await cust.goto(`/portal/${TOP_LINE_SLUG}/orders`);
    await expect(cust.getByRole("heading", { name: "Orders" })).toBeVisible();
    const otherOrder = (await sql<{ id: string; order_number: string }>(
      "select o.id, o.order_number from public.orders o join public.customers c on c.id = o.customer_id where o.company_id = $1 and c.name <> $2 and o.status <> 'draft' limit 1",
      [TOP_LINE, CUSTOMER],
    ))[0];
    if (otherOrder) {
      await expect(cust.getByText(`Order ${otherOrder.order_number}`)).toHaveCount(0);
      // Not even by typing its address.
      const r = await cust.goto(`/portal/${TOP_LINE_SLUG}/orders/${otherOrder.id}`);
      expect(r?.status()).toBe(404);
    }

    // Request a quote; the same request again is not duplicated.
    await cust.goto(`/portal/${TOP_LINE_SLUG}/quotes`);
    const form = cust.getByRole("form", { name: "Request a quote" });
    const material = `Pea gravel ${unique()}`;
    await form.getByLabel("Material").fill(material);
    await form.getByLabel("Quantity").fill("12");
    await form.getByLabel("Unit").fill("tons");
    await form.getByRole("button", { name: "Send Request" }).click();
    await expect(cust.getByText("Request sent. We will reply with a quote.")).toBeVisible();
    await form.getByLabel("Material").fill(material.toLowerCase());
    await form.getByLabel("Quantity").fill("12");
    await form.getByRole("button", { name: "Send Request" }).click();
    await expect(cust.getByText(/We already have this request/)).toBeVisible();

    // Support: a question, answered by the office.
    await cust.goto(`/portal/${TOP_LINE_SLUG}/support/new`);
    const subject = `Gate code ${unique()}`;
    await cust.getByLabel("Subject").fill(subject);
    await cust.getByLabel("Message").fill("What is the gate code for the north entrance?");
    await cust.getByRole("button", { name: "Send" }).click();
    await expect(cust.getByText(/Sent\. .* will reply here/)).toBeVisible();

    // A customer account never reaches the workspace.
    await cust.goto("/command-center");
    await expect(cust).toHaveURL(new RegExp(`/portal/${TOP_LINE_SLUG}$`));
    await cust.goto("/customer-portal");
    await expect(cust).toHaveURL(new RegExp(`/portal/${TOP_LINE_SLUG}$`));

    // The office sees both requests and answers the question.
    await page.goto("/customer-portal");
    await expect(page.getByText(`${CUSTOMER} · ${material}`)).toBeVisible();
    const thread = page.getByRole("listitem").filter({ hasText: `${CUSTOMER} · ${subject}` });
    await expect(thread.getByText(`${CUSTOMER} · ${subject}`)).toBeVisible();
    await thread.getByLabel("Reply").fill("It is 4412. Drive slowly past the scale.");
    await thread.getByRole("button", { name: "Send Reply" }).click();
    await expect(page.getByText("Reply sent to the customer's portal.")).toBeVisible();

    await cust.goto(`/portal/${TOP_LINE_SLUG}/support`);
    await cust.getByRole("link", { name: new RegExp(subject) }).click();
    await expect(cust.getByText("It is 4412. Drive slowly past the scale.")).toBeVisible();

    // Turning the portal off closes it immediately.
    await sql("update public.portal_settings set enabled = false where company_id = $1", [TOP_LINE]);
    await cust.goto(`/portal/${TOP_LINE_SLUG}/orders`);
    await expect(cust.getByRole("heading", { name: "This customer portal is not available" })).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("staff without customer access cannot open the portal administration; the portal is off by default", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/customer-portal");
  await expect(page).toHaveURL(/no-access|\/driver/);
  const anon = await page.context().browser()!.newContext();
  const p = await anon.newPage();
  await p.goto(`/portal/${TOP_LINE_SLUG}`);
  await expect(p.getByRole("heading", { name: "This customer portal is not available" })).toBeVisible();
  await anon.close();
});
