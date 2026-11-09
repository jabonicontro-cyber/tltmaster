import { expect, test } from "@playwright/test";
import pg from "pg";
import { signIn, unique } from "./helpers";

// Easier driver sign-ins: from the driver's own Fleet page an owner sets up a phone sign-in in one step (no email),
// the sign-in is made on the driver's People record and the driver record follows it, so the driver's first sign-in
// opens My Day instead of "Your account is not linked to a driver yet". Fictional people only; nothing is emailed.

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

test.afterAll(async () => {
  await sql("update public.company_memberships set active = false where user_id in (select id from auth.users where email like 'e2e-phone-%@users.mytaviron.com')");
  await sql("update public.drivers set active = false where company_id = $1 and name like 'E2E Phone Driver %'", [TOP_LINE]);
});

test("a driver without a login gets a phone sign-in from Fleet in one step and lands on My Day", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const name = `E2E Phone Driver ${unique()}`;
  const username = `e2e-phone-${unique()}`;
  // A driver added in Fleet (its People record is added by the database trigger driver_person_insert).
  const driverId = (await sql<{ id: string }>("insert into public.drivers (company_id, name) values ($1, $2) returning id", [TOP_LINE, name]))[0].id;

  await signIn(page, "owner");
  await page.goto(`/fleet/drivers/${driverId}`);
  const card = page.getByRole("heading", { name: "Phone sign-in" }).locator("xpath=ancestor::*[contains(@class,'rounded-panel')][1]");
  await expect(card.getByText("No email needed.")).toBeVisible();
  await card.getByRole("link", { name: "Set up phone sign-in" }).click();
  await page.waitForURL(/\/employees\/new-sign-in\?employee=/);
  // Started from the driver's own record: name filled in, Driver chosen.
  await expect(page.getByRole("textbox", { name: /^Name/ })).toHaveValue(name);
  await expect(page.getByLabel("Driver")).toBeChecked();
  await page.getByLabel("Username").fill(username);
  await expect(page.getByText(`${username} is available`)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Create Sign-in" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Linked to their driver record" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Sign-in instructions" });
  await panel.getByRole("button", { name: "Show", exact: true }).click();
  const temp = (await panel.getByText(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/).textContent())!.trim();
  // The driver record follows the sign-in (no second person, no manual link).
  const linked = await sql<{ n: number }>("select count(*)::int n from public.drivers d join public.employees e on e.driver_id = d.id and e.user_id = d.user_id where d.id = $1", [driverId]);
  expect(linked[0].n).toBe(1);

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const driver = await phone.newPage();
  try {
    await driver.goto("/login");
    await driver.getByLabel("Email or username").fill(username);
    await driver.getByLabel("Password", { exact: true }).fill(temp);
    await driver.getByRole("button", { name: "Sign in" }).click();
    await driver.waitForURL(/\/welcome$/);
    await driver.getByLabel("New password").fill("Gravel-Road-2026!");
    await driver.getByLabel("Type it again").fill("Gravel-Road-2026!");
    await driver.getByRole("button", { name: "Save My Password" }).click();
    await driver.waitForURL(/\/driver/);
    await expect(driver.getByRole("heading", { name: "My Day" })).toBeVisible();
    await expect(driver.getByText("Your account is not linked to a driver yet")).toHaveCount(0);
  } finally {
    await phone.close();
  }

  // Back on the Fleet page the card is gone: the driver has a login.
  await page.goto(`/fleet/drivers/${driverId}`);
  await expect(page.getByRole("heading", { name: "Phone sign-in" })).toHaveCount(0);
});
