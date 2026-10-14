import { expect, test } from "@playwright/test";
import { expectToast, signIn } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";
import { driverUserId } from "./driver-fixture";

// Time-off approval chains (20261112000400): the owner sets the chain in Settings → Time off; a pending request shows
// the step it waits for; approving an earlier step passes it on; the last step approves. Fictional data only. The
// chain is cleared afterwards so other specs keep the single-approval default (the suite runs one worker).

const clearChain = () => asUser(USERS.owner.email, (q) => q("select public.time_off_set_chain('[]'::jsonb)"));

test.afterEach(clearChain);

test("an owner sets a two-step chain; a request waits for each step and the last step approves it", async ({ page }) => {
  // A pending request from the e2e driver, three weeks out (earlier open requests canceled).
  const userId = await driverUserId();
  const requestId = await asUser(USERS.owner.email, async (q) => {
    const emp = (await q("select id from public.employees where user_id = $1", [userId])).rows[0]?.id as string | undefined;
    const empId = emp ?? ((await q("insert into public.employees (user_id, full_name) values ($1, 'Drew Driver') returning id", [userId])).rows[0].id as string);
    for (const r of (await q("select id from public.time_off_requests where employee_id = $1 and status in ('pending', 'approved')", [empId])).rows) {
      await q("select public.time_off_cancel($1, 'e2e cleanup')", [r.id]);
    }
    return empId;
  }).then(async () =>
    asUser(USERS.driver.email, async (q) => {
      const day = (await q("select to_char((now() at time zone 'America/Chicago')::date + 23, 'YYYY-MM-DD') as d")).rows[0].d as string;
      return (await q("select public.time_off_save($1::jsonb) as r", [JSON.stringify({ category: "personal", start_date: day, end_date: day })])).rows[0].r.id as string;
    }),
  );

  await signIn(page, "owner");
  await page.goto("/settings?tab=time-off");
  await expect(page.getByRole("heading", { name: "Time-off approval chain" })).toBeVisible();
  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByLabel("Step name").last().fill("First review");
  await page.getByRole("button", { name: "Add a step" }).click();
  await page.getByLabel("Step name").last().fill("Final approval");
  await page.getByRole("button", { name: "Save approval chain" }).click();
  await expectToast(page, /Approval chain saved/);

  await page.goto(`/time-off/${requestId}`);
  await expect(page.getByText("Waiting for step 1 of 2: First review")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Approve" }).last().click();
  await expectToast(page, /Step approved\. The request now waits for step 2/);
  await expect(page.getByText("Waiting for step 2 of 2: Final approval")).toBeVisible();
  await expect(page.getByText("Step approved", { exact: true })).toBeVisible(); // history

  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "Approve" }).last().click();
  await expectToast(page, /Request approved|Approved/);
  await expect(page.getByText(/Waiting for step/)).toHaveCount(0);
});

test("people without settings access do not see the Time off settings tab", async ({ page }) => {
  await signIn(page, "dispatcher");
  await page.goto("/settings?tab=time-off");
  await expect(page.getByRole("heading", { name: "Time-off approval chain" })).toHaveCount(0);
});
