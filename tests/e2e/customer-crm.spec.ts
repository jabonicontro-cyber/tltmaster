import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

// Company CRM (20261119000100): a prospect is worked from its page — account, activity, follow-up, opportunity — shows
// on the pipeline, and becomes a customer when the opportunity is won. Dispatch reads it; drivers cannot open it.

test("office works a prospect from first call to won, and the pipeline follows", async ({ page }) => {
  test.slow();
  const name = `CRM Prospect ${unique()}`;
  await signIn(page, "office");

  // New customer as a prospect; the same name again is flagged as a possible duplicate.
  await page.goto("/customers/new");
  await page.getByLabel("Customer name").fill(name);
  await page.getByLabel("Relationship").selectOption("prospect");
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}\?created=1/);
  const customerUrl = page.url().split("?")[0];
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.goto("/customers/new");
  await page.getByLabel("Customer name").fill(name.toUpperCase());
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByText(/Possible duplicate: .*same name/)).toBeVisible();

  await page.goto(customerUrl);
  const account = page.getByRole("region", { name: "Account" });
  await expect(account.getByText("Prospect", { exact: true })).toBeVisible();
  await page.getByText("Edit account").click();
  await page.getByLabel("Tags").fill("quarry, priority");
  await page.getByRole("button", { name: "Save account" }).click();
  await expect(page.getByText("Account saved.")).toBeVisible();

  await page.getByLabel("Summary").fill("Intro call — wants three loads a week");
  await page.getByRole("button", { name: "Log activity" }).click();
  await expect(page.getByRole("list", { name: "Activity history" })).toContainText("Intro call — wants three loads a week");

  await page.getByLabel("Follow-up", { exact: true }).fill("Send rates");
  await page.getByLabel("Due", { exact: true }).fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Add follow-up" }).click();
  await expect(page.getByRole("list", { name: "Follow-ups" })).toContainText("Send rates");

  await page.getByText("New opportunity").click();
  await page.getByLabel("What is it").fill("Spring gravel");
  await page.getByLabel("Value ($)").last().fill("12500");
  await page.getByRole("button", { name: "Add opportunity" }).click();
  await expect(page.getByText("Opportunity saved.")).toBeVisible();

  await page.goto("/customers/pipeline");
  await expect(page.getByRole("region", { name: "New lead" })).toContainText("Spring gravel");
  await expect(page.getByRole("list", { name: "Due this week" })).toContainText("Send rates");

  // Won: the prospect becomes a customer (the same record).
  await page.goto(customerUrl);
  await page.getByText("Update", { exact: true }).first().click();
  await page.getByLabel("Stage").first().selectOption("won");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Opportunity saved.")).toBeVisible();
  await expect(account.locator("span").filter({ hasText: /^Customer$/ })).toBeVisible();

  // The list filters by tag and exports the same rows as CSV.
  await page.goto("/customers?tag=quarry");
  await expect(page.getByRole("link", { name })).toBeVisible();
  const csv = await page.request.get(`/customers/export?q=${encodeURIComponent(name)}`);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain(`${name},customer`);
});

test("dispatch reads customer CRM records but cannot change them; drivers cannot open customers", async ({ page }) => {
  const id = await asUser(USERS.office.email, async (q) => {
    const c = (await q("insert into public.customers (name, relationship) values ($1, 'prospect') returning id", [`CRM Read ${unique()}`])).rows[0].id as string;
    await q("insert into public.crm_opportunities (customer_id, title) values ($1, 'Visible to dispatch')", [c]);
    return c;
  });
  await signIn(page, "dispatcher");
  await page.goto(`/customers/${id}`);
  await expect(page.getByText("Visible to dispatch")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log activity" })).toHaveCount(0);
  await expect(page.getByText("New opportunity")).toHaveCount(0);
  await page.context().clearCookies();
  await signIn(page, "driver");
  await page.goto("/customers/pipeline");
  await expect(page).toHaveURL(/\/no-access|\/driver/);
});
