import { expect, test } from "@playwright/test";
import { expectToast, signIn } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";
import { driverUserId } from "./driver-fixture";

// Driver time off: request → approve → driver unavailable to dispatch on those dates.
// Fictional data only.

/** The e2e driver's employee record, linked to an active driver record; earlier e2e requests canceled. */
async function driverEmployee() {
  const userId = await driverUserId();
  return asUser(USERS.owner.email, async (q) => {
    let driverId = (await q("select id from public.drivers where user_id = $1 and active", [userId])).rows[0]?.id as string | undefined;
    if (!driverId) driverId = (await q("insert into public.drivers (user_id) values ($1) returning id", [userId])).rows[0].id as string;
    let empId = (await q("select id from public.employees where user_id = $1", [userId])).rows[0]?.id as string | undefined;
    if (!empId) empId = (await q("insert into public.employees (user_id, full_name, driver_id) values ($1, 'Drew Driver', $2) returning id", [userId, driverId])).rows[0].id as string;
    else await q("update public.employees set driver_id = $2 where id = $1", [empId, driverId]);
    const open = (await q("select id from public.time_off_requests where employee_id = $1 and status in ('pending', 'approved')", [empId])).rows;
    for (const r of open) await q("select public.time_off_cancel($1, 'e2e cleanup')", [r.id]);
    const day = (await q("select to_char((now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date + 21, 'YYYY-MM-DD') as d")).rows[0].d as string;
    return { empId, driverId, day };
  });
}

test("a driver requests time off, an approver approves it, and dispatch shows the driver on leave", async ({ page, browser }) => {
  const { day } = await driverEmployee();
  await signIn(page, "driver");
  await page.goto("/driver");
  await page.getByRole("link", { name: "Request time off" }).click();
  await expect(page.getByText("Balances are not tracked yet")).toBeVisible();
  await page.getByLabel("Category").selectOption("vacation");
  await page.getByLabel("First day").fill(day);
  await page.getByLabel("Comment (optional)").fill("Family event (e2e)");
  await page.getByRole("button", { name: "Send request" }).click();
  await expectToast(page, "Time-off request sent.");
  const row = page.getByRole("row", { name: /full day/ }).first();
  await expect(row).toContainText("Pending");
  // Sending the same dates again is refused (no double counting).
  await page.getByLabel("First day").fill(day);
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText(/overlaps another request/)).toBeVisible();
  // Drivers cannot decide.
  await row.getByRole("link").click();
  await page.waitForURL(/\/time-off\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /Vacation/, level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const url = page.url();

  const owner = await browser.newPage();
  await signIn(owner, "owner");
  await owner.goto(url);
  await owner.getByRole("button", { name: "Approve" }).click();
  await owner.getByLabel("Note (optional)").fill("Approved (e2e)");
  await owner.getByRole("button", { name: "Approve" }).last().click();
  await expectToast(owner, /Approved|Request approved/);
  await expect(owner.getByText("Approved", { exact: true }).first()).toBeVisible();

  await owner.goto(`/dispatch/resources?date=${day}&q=Drew`);
  await expect(owner.getByRole("row", { name: /Drew/ }).first()).toContainText("Approved leave");
  await owner.close();

  await page.reload();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
});

test("other companies cannot open a request, and people without approval rights cannot decide", async ({ page, browser }) => {
  const { empId, day } = await driverEmployee();
  const id = await asUser(USERS.owner.email, async (q) =>
    (await q("select public.time_off_save($1::jsonb) as r", [JSON.stringify({ employee_id: empId, category: "personal", start_date: day, full_day: false, start_time: "08:00", end_time: "12:00" })])).rows[0].r.id as string);

  await signIn(page, "dispatcher");
  await page.goto(`/time-off/${id}`);
  await expect(page.getByText("08:00", { exact: false }).or(page.getByText("8:00", { exact: false })).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0); // view, not approve

  const other = await browser.newPage();
  await signIn(other, "otherOwner");
  await other.goto(`/time-off/${id}`);
  await expect(other.getByText("Not found", { exact: true })).toBeVisible();
  await other.close();
});
