import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// The mechanic's phone workspace (docs/COMPANION_APP.md): My jobs is home, the mechanic tab bar shows on a phone, and
// a job taken from "Needs a mechanic" can be started, timed and finished with the same rules as the work order page.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("a mechanic takes a job on a phone, starts it, times it and marks their part done", async ({ page }) => {
  const title = `My jobs test ${unique()}`;
  await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("select id from public.trucks where active and service_status = 'in_service' order by unit_number limit 1")).rows[0].id as string;
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title, category: "tires", urgency: "immediate", safety_critical: true })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'triaged')", [wo]);
  });

  await signIn(page, "mechanic");
  await page.goto("/maintenance/my-jobs");
  const tabs = page.getByRole("navigation", { name: "Mechanic tabs" });
  await expect(tabs.getByRole("link", { name: "My jobs" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "Work orders" })).toBeVisible();

  // Take it: the mechanic becomes the lead, the same as being assigned on the work order.
  const open = page.getByRole("listitem").filter({ hasText: title });
  await open.getByRole("button", { name: "Take this job" }).click();
  await expectToast(page, "Lead mechanic set.");
  const mine = page.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "You lead this job" });
  await expect(mine).toBeVisible();
  await expect(mine.getByRole("button", { name: "My part is done" })).toHaveCount(0); // not before the job starts

  await mine.getByRole("button", { name: "Start this job" }).click();
  await expectToast(page, "Status: In progress.");
  await mine.getByRole("button", { name: "Start timer" }).click();
  await expectToast(page, "Timer started.");
  await expect(page.getByRole("region", { name: "Your running timer" })).toContainText(/Timer running/);
  await page.getByRole("region", { name: "Your running timer" }).getByRole("button", { name: "Stop timer" }).click();
  await expectToast(page, "Timer stopped.");
  await expect(page.getByRole("region", { name: "Your running timer" })).toHaveCount(0);

  await mine.getByRole("button", { name: "My part is done" }).click();
  await expectToast(page, /./);
  await expect(page.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "You lead this job" })).toHaveCount(0);
});

test("people without maintenance access cannot open My jobs", async ({ page }) => {
  await signIn(page, "driver");
  const res = await page.goto("/maintenance/my-jobs");
  expect([200, 403, 404]).toContain(res?.status() ?? 0);
  await expect(page.getByRole("heading", { name: "Maintenance" })).toHaveCount(0);
});
