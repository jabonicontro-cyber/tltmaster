import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn, signInPlatform } from "./helpers";

// Guided onboarding (20261120001000), end to end on the local stack: Taviron starts a checklist for a company; the
// company's owner uploads a CSV to a reviewed task and submits it (they cannot approve it); Taviron opens the file in
// the importer (nothing is created until a batch is approved), requests changes with a reason; the owner sees the
// reason and an in-app notice (never an email), resubmits; Taviron approves. The lifecycle is never touched.

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

async function clean() {
  await sql("delete from public.comm_notifications where company_id = $1 and category = 'onboarding'", [TOP_LINE]);
  await sql("delete from public.onboarding_tasks where company_id = $1", [TOP_LINE]);
}

test.beforeEach(clean);
test.afterEach(clean);

test("Taviron starts onboarding, the company submits a file, Taviron requests changes and approves", async ({ page, browser }) => {
  const lifecycleBefore = await sql("select stage, go_live_on::text, live_at from private.company_lifecycle where company_id = $1", [TOP_LINE]);

  // Taviron: start the checklist.
  await signInPlatform(page);
  await page.goto(`/admin/onboarding/${TOP_LINE}`);
  await page.getByRole("button", { name: "Start Onboarding" }).click();
  await expect(page.getByText(/tasks? added to the checklist/).first()).toBeVisible();
  await expect(page.getByText("Send your customer list").first()).toBeVisible();

  // The company's owner, in their own browser.
  const ctx = await browser.newContext();
  const owner = await ctx.newPage();
  try {
    await signIn(owner, "owner");
    await owner.goto("/setup#task-customers");
    await expect(owner.getByRole("heading", { name: "Onboarding with Taviron" })).toBeVisible();
    const task = owner.locator("#task-customers");
    await task.locator("summary").click();
    await task.getByLabel("Add a file").setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from("name,email\nE2E Onboarding Customer,ap@e2e.example\n") });
    await expect(task.getByRole("link", { name: "customers.csv" })).toBeVisible();
    // Reviewed task: the company submits, it cannot approve.
    await expect(task.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await task.getByRole("button", { name: "Submit for review" }).click();
    await expect(task.getByText("Submitted for review").first()).toBeVisible();

    // Taviron: open the file in the importer, then request changes with a reason.
    await page.goto(`/admin/onboarding/${TOP_LINE}`);
    const staffTask = page.locator("#task-customers");
    await expect(staffTask.getByText("Submitted for review").first()).toBeVisible();
    await staffTask.getByRole("link", { name: "Import this file…" }).click();
    await expect(page.getByText(/Opened customers\.csv from the company's onboarding checklist/)).toBeVisible();
    await page.goto(`/admin/onboarding/${TOP_LINE}`);
    await page.locator("#task-customers").getByRole("button", { name: "Request changes" }).click();
    await page.locator("#task-customers").getByLabel(/Reason/).fill("Please add billing addresses");
    await page.locator("#task-customers").getByRole("button", { name: "Request changes" }).click();
    await expect(page.locator("#task-customers").getByText("Changes requested").first()).toBeVisible();

    // The owner sees the reason; the notice is in-app only. (A reload: same address, only the #anchor would differ.)
    await owner.reload();
    await expect(owner.locator("#task-customers").getByText("Please add billing addresses").first()).toBeVisible();
    const notes = await sql<{ title: string }>("select title from public.comm_notifications where company_id = $1 and category = 'onboarding'", [TOP_LINE]);
    expect(notes.map((n) => n.title)).toContain("Changes requested: Send your customer list");
    await owner.locator("#task-customers").getByRole("button", { name: "Resubmit for review" }).click();
    // Wait for the new state itself, in the task's status badge: "Submitted for review" is also in the task's history
    // from the first submission, so matching that text anywhere passed before the resubmission was saved (and Taviron
    // then found nothing to approve).
    await expect(owner.locator("#task-customers summary").getByText("Submitted for review")).toBeVisible();

    // Taviron approves.
    await page.reload();
    await page.locator("#task-customers").getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("#task-customers").getByText("Approved").first()).toBeVisible();
    await owner.reload();
    await expect(owner.locator("#task-customers").getByText("Approved").first()).toBeVisible();
  } finally {
    await ctx.close();
  }
  // Onboarding never changes the lifecycle (go-live date, stage).
  expect(await sql("select stage, go_live_on::text, live_at from private.company_lifecycle where company_id = $1", [TOP_LINE])).toEqual(lifecycleBefore);
});

test("people without settings.manage do not see the checklist", async ({ page }) => {
  await sql("select private.onboarding_generate($1, '{}'::jsonb)", [TOP_LINE]);
  await signIn(page, "dispatcher");
  const res = await page.goto("/setup");
  expect(page.url()).toMatch(/no-access|setup/);
  if (res && page.url().includes("/setup")) await expect(page.getByRole("heading", { name: "Onboarding with Taviron" })).toHaveCount(0);
});
