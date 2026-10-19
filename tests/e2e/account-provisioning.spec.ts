import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";

// Employee username sign-ins (20261120001200; docs/ACCOUNT_PROVISIONING.md), end to end on the local stack: an owner
// creates a driver with a username, reviews the role, and gets print/copy instructions with a temporary password; the
// driver signs in on a phone, cannot reach anything before choosing a password, sets one and lands on My Day; the
// owner turns the sign-in off and the driver can no longer sign in. Fictional people only; nothing is emailed.

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

// Audit history is append-only, so test sign-ins are kept; they are turned off and their people records removed.
test.afterAll(async () => {
  await sql("delete from public.employees where full_name like 'E2E Prov %'");
  await sql("update public.company_memberships set active = false where user_id in (select id from auth.users where email like 'e2e-prov-%@users.mytaviron.com')");
});

async function signInAs(page: Page, username: string, password: string, shared = false) {
  await page.goto("/login");
  await page.getByLabel("Email or username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  if (shared) await page.getByLabel(/shared computer/).check();
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("an owner creates a driver sign-in; the driver sets a password on a phone and lands on My Day; turning it off ends access", async ({ page, browser, context }) => {
  test.setTimeout(180_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = `E2E Prov Driver ${unique()}`;
  const username = `e2e-prov-${unique()}`;

  await signIn(page, "owner");
  await page.goto("/employees/new-sign-in");
  await page.getByLabel("Driver").check();
  await page.getByRole("textbox", { name: /^Name/ }).fill(name);
  await page.getByLabel("Username").fill(username);
  await expect(page.getByText(`${username} is available`)).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Role: Driver" })).toBeVisible();
  await page.getByRole("button", { name: "Create Sign-in" }).click();

  // Delivery: the password is hidden until shown; email is unavailable on this server (preview mode), print and copy work.
  const panel = page.getByRole("region", { name: "Sign-in instructions" });
  await expect(panel.getByText(username)).toBeVisible();
  await expect(panel.getByText("•••• •••• ••••")).toBeVisible();
  await panel.getByRole("button", { name: "Show", exact: true }).click();
  const temp = (await panel.getByText(/^[A-Za-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/).textContent())!.trim();
  await expect(panel.getByText(/Email sending is not set up/)).toBeVisible();
  await panel.getByRole("button", { name: "Copy Without Password" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`Username: ${username}`);
  expect(copied).not.toContain(temp);
  await panel.getByRole("button", { name: "Print Sign-in Sheet" }).click();
  const sheet = page.getByRole("article", { name: "Sign-in sheet" });
  await expect(sheet.getByText(username)).toBeVisible();
  await expect(sheet.getByText(temp)).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  // Nothing about the temporary password is stored: the database has only a fingerprint of the hash.
  const stored = await sql<{ n: number }>("select count(*)::int n from private.account_setups where username = $1 and credential_fingerprint <> $2", [username, temp]);
  expect(stored[0].n).toBe(1);
  const leaked = await sql<{ n: number }>("select count(*)::int n from public.audit_events where details::text like '%' || $1 || '%'", [temp]);
  expect(leaked[0].n).toBe(0);

  // The driver, on a phone, on a shared device.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const driver = await phone.newPage();
  try {
    await signInAs(driver, username, temp, true);
    await driver.waitForURL(/\/welcome$/);
    await expect(driver.getByRole("heading", { name: /Welcome/ })).toBeVisible();
    // Shared computer: the session cookies end with the browser (no expiry).
    const cookies = await phone.cookies();
    const auth = cookies.filter((c) => c.name.includes("auth-token"));
    expect(auth.length).toBeGreaterThan(0);
    for (const c of auth) expect(c.expires).toBe(-1);
    // No way around setup: any app page sends them back.
    await driver.goto("/command-center");
    await driver.waitForURL(/\/welcome$/);
    await driver.getByLabel("New password").fill("Gravel-Road-2026!");
    await driver.getByLabel("Type it again").fill("Gravel-Road-2027!");
    await driver.getByRole("button", { name: "Save My Password" }).click();
    await expect(driver.locator("#confirm-error")).toHaveText("The two passwords do not match.");
    await driver.getByLabel("Type it again").fill("Gravel-Road-2026!");
    await driver.getByRole("button", { name: "Save My Password" }).click();
    await driver.waitForURL(/\/driver/);

    // The temporary password no longer works; the new one does.
    await driver.context().clearCookies();
    await signInAs(driver, username, temp);
    await expect(driver.getByText("Username or password is incorrect.")).toBeVisible();
    await signInAs(driver, username, "Gravel-Road-2026!");
    await driver.waitForURL(/\/driver/);

    // The owner sees the status, then turns the sign-in off.
    const person = (await sql<{ id: string }>("select id from public.employees where full_name = $1", [name]))[0];
    await page.goto(`/employees/${person.id}`);
    await expect(page.getByText(/Active|First sign-in completed/).first()).toBeVisible();
    await page.getByRole("button", { name: "Turn Off Sign-in" }).click();
    await page.getByRole("button", { name: "Turn Off", exact: true }).click();
    await expect(page.getByText(/Sign-in turned off/).first()).toBeVisible();
    await driver.context().clearCookies();
    await signInAs(driver, username, "Gravel-Road-2026!");
    await expect(driver.getByText(/turned off|incorrect/)).toBeVisible();
  } finally {
    await phone.close();
  }
});

test("a username that is taken is refused, and people without users.manage cannot open sign-in creation", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/employees/new-sign-in");
  await page.getByRole("textbox", { name: /^Name/ }).fill("E2E Prov Taken");
  await page.getByLabel("Username").fill("colbychapman-taken-check");
  await sql("insert into private.account_provisions (request_key, company_id, kind, username) values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', 'employee', 'e2e-prov-taken') on conflict do nothing");
  await page.getByLabel("Username").fill("e2e-prov-taken");
  await expect(page.getByText("e2e-prov-taken is taken")).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText("That username is taken. Choose another.")).toBeVisible();

  const ctx = await page.context().browser()!.newContext();
  const d = await ctx.newPage();
  await signIn(d, "dispatcher");
  await d.goto("/employees/new-sign-in");
  await expect(d).toHaveURL(/no-access/);
  await ctx.close();
});
