import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";

// Accountant view (B134), end to end on the local stack: an owner gives an outside accountant a read-only sign-in
// until a date; the accountant sets a password, lands on the accountant view, sees only the finance pages and cannot
// reach anything else; the owner ends the access and the accountant sees nothing. Fictional people only; nothing is
// emailed.

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

async function signInAs(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("an owner gives an accountant read-only access until a date, then ends it", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const name = `E2E Acct ${unique()}`;
  const username = `e2e-acct-${unique()}`;

  await signIn(page, "owner");
  await page.goto("/settings?tab=accountants");
  await expect(page.getByRole("heading", { name: "Accountant access", exact: true }).first()).toBeVisible();
  const form = page.getByRole("form", { name: "Give an accountant access" });
  await form.locator("#acc-name").fill(name);
  await form.locator("#acc-username").fill(username);
  await form.getByLabel(/Include driver payroll/).check();
  await form.getByRole("button", { name: "Create accountant sign-in" }).click();

  const panel = page.getByRole("region", { name: "Sign-in instructions" });
  await expect(panel.getByText(username)).toBeVisible();
  await panel.getByRole("button", { name: "Show", exact: true }).click();
  const temp = (await panel.getByText(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/).textContent())!.trim();
  await panel.getByRole("button", { name: "Done", exact: true }).click();
  const row = page.getByRole("listitem", { name: `Accountant ${name}` });
  await expect(row).toContainText("Payroll included");
  await expect(row).toContainText(/Until /);

  // The accountant: set a password, land on the accountant view, see only the finance pages.
  const ctx = await browser.newContext();
  const acct = await ctx.newPage();
  try {
    await signInAs(acct, username, temp);
    await acct.waitForURL(/\/welcome$/);
    await acct.getByLabel("New password").fill("Ledger-Season-2027!");
    await acct.getByLabel("Type it again").fill("Ledger-Season-2027!");
    await acct.getByRole("button", { name: "Save My Password" }).click();
    await acct.waitForURL(/\/accountant/);
    await expect(acct.getByRole("heading", { name: "Accountant view" })).toBeVisible();
    await expect(acct.getByText(/Your access ends /)).toBeVisible();
    await expect(acct.getByRole("region", { name: /Driver payroll/ }).or(acct.getByText(/Driver payroll —/))).toBeVisible();
    const nav = (await acct.getByRole("navigation", { name: "Main" }).getByRole("link").allTextContents()).map((t) => t.trim()).filter(Boolean);
    expect(nav.sort()).toEqual(["Accountant view", "Billing", "Reports"]);
    const csv = await acct.request.get(`/accountant/export?kind=invoices&year=${new Date().getFullYear() - 1}`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    // Operations, people and settings are not theirs.
    for (const path of ["/dispatch", "/employees", "/payroll", "/customers/new"]) {
      await acct.goto(path);
      await expect(acct, path).toHaveURL(/no-access|accountant/);
    }
    await acct.goto("/command-center");
    await expect(acct).toHaveURL(/\/accountant/);

    // The owner ends it: the accountant no longer sees the company.
    await page.reload();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("listitem", { name: `Accountant ${name}` }).getByRole("button", { name: "End access now" }).click();
    await expect(page.getByRole("listitem", { name: `Accountant ${name}` })).toContainText("Ended");
    await acct.goto("/accountant");
    await expect(acct.getByRole("heading", { name: "Accountant view" })).toHaveCount(0);
    const visits = await sql<{ n: number }>("select count(*)::int n from public.audit_events e join auth.users u on u.id = e.actor_id where e.action = 'accountant.visited' and u.email like $1", [`${username}@%`]);
    expect(visits[0].n).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});
