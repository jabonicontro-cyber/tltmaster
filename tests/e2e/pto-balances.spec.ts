import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";
import { driverUserId } from "./driver-fixture";

// PTO banks and balances (20261112000100): an owner sets up a bank and grants hours; the employee sees the balance,
// a request above it is refused, one within it is sent and approval uses the hours. The bank covers Bereavement only
// (no other spec uses it) and is deactivated afterwards, so other specs keep requesting without a balance.
// Fictional data only.

async function driverEmployee() {
  const userId = await driverUserId();
  return asUser(USERS.owner.email, async (q) => {
    let empId = (await q("select id from public.employees where user_id = $1", [userId])).rows[0]?.id as string | undefined;
    if (!empId) empId = (await q("insert into public.employees (user_id, full_name) values ($1, 'Drew Driver') returning id", [userId])).rows[0].id as string;
    await q("update public.employees set employment_type = 'full_time', status = 'active' where id = $1", [empId]);
    const open = (await q("select id from public.time_off_requests where employee_id = $1 and status in ('pending', 'approved')", [empId])).rows;
    for (const r of open) await q("select public.time_off_cancel($1, 'e2e cleanup')", [r.id]);
    // Any earlier test bank on Bereavement is retired first (one active bank per kind of time off).
    const old = (await q("select id, name, categories, employment_types, waiting_days from public.pto_banks where active and 'bereavement' = any (categories)")).rows;
    for (const b of old) await q("select public.pto_bank_save($1::jsonb)", [JSON.stringify({ ...b, active: false })]);
    const day = (await q("select to_char((now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date + 30, 'YYYY-MM-DD') as d")).rows[0].d as string;
    return { empId, day };
  });
}

test("an owner sets up a bank and grants hours; requests are checked against the balance and approval uses it", async ({ page, browser }) => {
  const { day } = await driverEmployee();
  const bankName = `Bereavement e2e ${unique()}`;
  try {
    await signIn(page, "owner");
    await page.goto("/time-off");
    await page.getByRole("link", { name: "Banks and balances", exact: true }).first().click();
    await page.waitForURL(/\/time-off\/balances$/);
    await expect(page.getByText("Coming soon")).toBeVisible(); // accruals, carryover and approval chains are labelled, not implied
    const create = page.locator("form").filter({ has: page.getByRole("button", { name: "Create bank" }) });
    await create.getByLabel("Bank name").fill(bankName);
    await create.getByLabel("Bereavement").check();
    await create.getByLabel("Full-time").check();
    await create.getByRole("button", { name: "Create bank" }).click();
    await expectToast(page, "Bank created.");

    const grant = page.locator("form").filter({ has: page.getByRole("button", { name: /Grant hours|Adjust balance/ }) });
    await grant.getByLabel("Employee").selectOption({ label: "Drew Driver" });
    await grant.getByLabel("Bank").selectOption({ label: bankName });
    await grant.getByLabel("Hours").fill("8");
    await grant.getByRole("button", { name: "Grant hours" }).click();
    await expectToast(page, "Hours granted.");
    await expect(page.getByRole("row", { name: new RegExp(`Drew Driver.*${bankName}`) }).first()).toContainText("8 h");

    // The employee sees the balance and cannot request more than is available.
    const driver = await browser.newPage();
    await signIn(driver, "driver");
    await driver.goto("/time-off");
    const balances = driver.getByRole("list", { name: "My balances" });
    await expect(balances.getByRole("listitem").filter({ hasText: bankName })).toContainText("8 h available");
    await driver.getByLabel("Category").selectOption("bereavement");
    await driver.getByLabel("First day").fill(day);
    await driver.getByLabel(`Hours of ${bankName}`).fill("12");
    await driver.getByRole("button", { name: "Send request" }).click();
    await expect(driver.getByText(/uses 12 h of .*, but only 8 h are available/)).toBeVisible();
    await driver.getByLabel(`Hours of ${bankName}`).fill("8");
    await driver.getByRole("button", { name: "Send request" }).click();
    await expectToast(driver, "Time-off request sent.");
    await driver.reload();
    await expect(driver.getByRole("list", { name: "My balances" }).getByRole("listitem").filter({ hasText: bankName })).toContainText("0 h available");
    const row = driver.getByRole("row", { name: /full day/ }).filter({ hasText: "Pending" }).first();
    await row.getByRole("link").click();
    await driver.waitForURL(/\/time-off\/[0-9a-f-]{36}$/);
    const url = driver.url();
    await driver.close();

    // Approval uses the hours: the history shows them as used.
    await page.goto(url);
    await page.getByRole("button", { name: "Approve" }).click();
    await page.getByRole("button", { name: "Approve" }).last().click();
    await expectToast(page, /Approved|Request approved/);
    await page.goto("/time-off/balances");
    await expect(page.getByRole("row", { name: /Drew Driver/ }).filter({ hasText: "Used" }).first()).toContainText("-8 h");
  } finally {
    await driverEmployee(); // cancels the request (hours return) and retires the test bank
  }
});

test("only people with time_off.balances open Banks and balances", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/time-off/balances");
  await page.waitForURL(/\/no-access\?missing=time_off\.balances/);
  await page.goto("/time-off");
  await expect(page.getByRole("link", { name: "Banks and balances" })).toHaveCount(0);
});
