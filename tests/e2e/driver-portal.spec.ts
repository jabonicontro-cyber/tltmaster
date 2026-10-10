import { expect, test, type Page } from "@playwright/test";
import { driverFixture as fixture, driverUserId, office } from "./driver-fixture";
import { expectToast, signIn } from "./helpers";


async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("a driver sees only their own day, sends a ticket (with a failed send and a retry) and reports a breakdown", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "driver");
  await expect(page).toHaveURL(/\/driver$/);
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible();
  await expect(page.getByText(/medical card expires on/)).toBeVisible();
  const still = page.getByRole("region", { name: "Tickets still needed" });
  const pastCard = still.getByRole("listitem", { name: `Load 1, ${f.orderNumber}` });
  await expect(pastCard).toContainText(f.myTruck);
  await pastCard.getByText("Instructions and directions").click();
  await expect(pastCard).toContainText("Dump at the north pad, back in from Elm St.");
  await expect(page.getByText(f.otherTruck)).toHaveCount(0);
  await expect(page.getByText("OFFICE-ONLY-NOTE e2e")).toHaveCount(0);
  await expect(page.getByText("$10.00")).toHaveCount(0);
  await noHorizontalScroll(page);

  // Ticket for yesterday's load.
  await pastCard.getByRole("link", { name: "Enter delivery ticket" }).click();
  await expect(page).toHaveURL(new RegExp(`/driver/assignments/${f.past}/ticket`));
  await expect(page.getByLabel("Gravel #53 limestone")).toBeChecked(); // the only line
  await page.getByLabel("Quantity on the ticket").fill("21.47");
  await page.getByRole("button", { name: "Send ticket" }).click();
  await expect(page.getByText("Tap the unit on the paper ticket.")).toBeVisible();
  await page.getByLabel(/^Tons/).check();
  await page.getByLabel("Delivery time").fill("08:30");
  await page.getByLabel("Paper / scale ticket number").fill(f.ref);
  await noHorizontalScroll(page);

  // No signal: nothing is reported as sent.
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Send ticket" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Not sent — no connection to the office" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/ticket$`));
  await page.context().setOffline(false);
  await page.getByRole("button", { name: "Send again" }).dblclick();
  await expect(page).toHaveURL(/\/driver\?sent=/);
  await expect(page.getByRole("status")).toContainText(/Ticket T-\d{4}-\d{5} sent to the office\./);
  const recent = page.getByRole("list", { name: "My recent tickets" });
  await expect(recent.getByText("Sent — waiting for office review").first()).toBeVisible();
  const count = await office(async (q) => (await q("select count(*)::int as n from public.delivery_tickets where external_reference = $1", [f.ref])).rows[0].n as number);
  expect(count).toBe(1); // one ticket despite the failed attempt and the double tap
  await expect(page.getByRole("region", { name: "Tickets still needed" })).toHaveCount(0);

  // Breakdown report on today's load.
  const todayCard = page.getByRole("region", { name: "Today" }).getByRole("listitem", { name: `Load 2, ${f.orderNumber}` });
  await todayCard.getByRole("link", { name: "Report a problem" }).click();
  await page.getByLabel(/^Breakdown/).check();
  await page.getByLabel(`Truck ${f.myTruck}`).check();
  await page.getByLabel("What happened?").fill("Air leak on the tag axle (e2e)");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByRole("status")).toContainText("Report sent to the office.");
  await expect(page.getByRole("list", { name: "My reports" })).toContainText("Sent — not seen yet");

  // Direct access to someone else's load or to office pages is refused.
  await page.goto(`/driver/assignments/${f.otherAssignment}/ticket`);
  await expect(page.getByText("This load is not available")).toBeVisible();
  for (const path of ["/tickets", "/billing", "/command-center", "/orders", "/field-reports"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/no-access/);
  }

  // The office sees the report, resolves it, and the driver sees the result.
  await page.context().clearCookies();
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page, "office");
  await page.goto("/command-center?kind=equipment_report");
  const item = page.getByRole("listitem", { name: new RegExp(`Drew Driver reported a problem with truck ${f.myTruck}`) });
  await expect(item.getByText("Urgent", { exact: true })).toBeVisible();
  await item.getByRole("link", { name: "Open the report" }).click();
  await expect(page).toHaveURL(/\/field-reports\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "Breakdown — Drew Driver" })).toBeVisible();
  await expect(page.getByText("Air leak on the tag axle (e2e)")).toBeVisible();
  await page.getByRole("button", { name: "Resolve" }).click();
  await page.getByRole("dialog").getByLabel("How was it resolved?").fill("Shop replaced the fitting (e2e)");
  await page.getByRole("dialog").getByRole("button", { name: "Resolve" }).click();
  await expectToast(page, "Report resolved.");
  const truckStatus = await office(async (q) => (await q("select service_status from public.trucks where unit_number = $1", [f.myTruck])).rows[0].service_status);
  expect(truckStatus).toBe("in_service"); // the report changed nothing by itself

  await page.context().clearCookies();
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, "driver");
  await expect(page.getByRole("list", { name: "My reports" })).toContainText("Resolved");
});

test("an account not linked to a driver record gets a clear message", async ({ page }) => {
  const userId = await driverUserId();
  await office(async (q) => {
    await q("update public.drivers set user_id = null, name = 'Drew Driver (unlinked by e2e)', active = false where user_id = $1", [userId]);
  });
  await signIn(page, "driver");
  await expect(page.getByText("Your account is not linked to a driver yet")).toBeVisible();
  await noHorizontalScroll(page);
});
