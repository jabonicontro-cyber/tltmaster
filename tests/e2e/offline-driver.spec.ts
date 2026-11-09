// Offline driver app (B133, owner 2026-11-02: cached day + queued sends). On a phone that loses signal: an Arrived tap
// and a delivery ticket are saved on the phone ("Waiting to send"), sent by themselves once signal returns, and reach
// the office with the tapped time and the ticket's own key. The offline page shows the day saved on the phone, marked
// with the time it was read. Sign-out removes it all. Fictional records only.
import { expect, test } from "@playwright/test";
import { driverFixture, office } from "./driver-fixture";
import { signIn } from "./helpers";

test.use({ viewport: { width: 390, height: 844 } });

test("without signal, taps and tickets wait on the phone and reach the office once signal returns", async ({ page, context }) => {
  const f = await driverFixture();
  await signIn(page, "driver");
  await expect(page.getByRole("heading", { name: "My Day" })).toBeVisible({ timeout: 30_000 });
  // My Day keeps today on the phone once it has loaded.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("taviron-offline-day")), { timeout: 20_000 }).toContain(f.myTruck);

  // A ticket typed without signal: saved on the phone, not sent.
  const card = page.getByRole("listitem", { name: `Load 2, ${f.orderNumber}` });
  await card.getByRole("link", { name: "Enter delivery ticket" }).click();
  await expect(page.getByRole("heading", { name: "Delivery ticket" })).toBeVisible();
  await context.setOffline(true);
  await page.getByLabel("Quantity on the ticket").fill("18.5");
  await page.getByLabel(/^Tons/).check();
  await page.getByLabel("Paper / scale ticket number").fill(f.ref);
  await page.getByRole("button", { name: "Send ticket" }).click();
  await expect(page.getByRole("status")).toContainText("Saved on this phone, not sent yet");

  // Still without signal, the app opens on the day saved on the phone: an Arrived tap waits there too, with its time.
  await page.goto("/driver").catch(() => undefined);
  await expect(page.getByText(/Your day as of .*No connection: this may be out of date/)).toBeVisible();
  const saved = page.getByRole("listitem", { name: `Load 2, ${f.orderNumber}` });
  await expect(saved).toContainText(f.myTruck);
  const tappedAt = Date.now();
  await saved.getByRole("form", { name: "Pickup times" }).getByRole("button", { name: "Arrived at pickup" }).click();
  const waiting = page.getByRole("region", { name: "Waiting to send" });
  await expect(waiting).toContainText("Waiting to send (2)");
  await expect(waiting).toContainText(`Arrived pickup · ${f.orderNumber} load 2`);
  await expect(waiting).toContainText(`Ticket for ${f.orderNumber} load 2`);
  await expect(saved.getByRole("form", { name: "Pickup times" })).toContainText("Arrived");

  await context.setOffline(false);
  // Back on My Day with signal: both are sent by themselves and the list empties.
  await page.goto("/driver");
  // The list lives on the phone, so the page first renders without it: wait until the office has both, then for the
  // list to empty.
  const reached = () => office(async (q) => ({
    stop: (await q("select arrived_at from public.load_stop_times t join public.order_loads l on l.id = t.load_id join public.orders o on o.id = l.order_id where o.order_number = $1 and l.load_number = 2 and t.stop = 'pickup'", [f.orderNumber])).rows[0],
    tickets: (await q("select count(*)::int n from public.delivery_tickets where external_reference = $1", [f.ref])).rows[0].n,
  }));
  await expect.poll(async () => { const r = await reached(); return r.tickets === 1 && Boolean(r.stop?.arrived_at); }, { timeout: 30_000 }).toBe(true);
  await expect(page.getByRole("region", { name: "Waiting to send" })).toHaveCount(0, { timeout: 30_000 });
  const rows = await reached();
  expect(rows.tickets).toBe(1);
  // The tapped time is kept (not the time it was sent).
  expect(Math.abs(new Date(rows.stop.arrived_at as string).getTime() - tappedAt)).toBeLessThan(60_000);
});

test("sign-out removes the saved day and anything waiting", async ({ page }) => {
  await driverFixture();
  await signIn(page, "driver");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("taviron-offline-day")), { timeout: 20_000 }).not.toBeNull();
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/login/);
  expect(await page.evaluate(() => [localStorage.getItem("taviron-offline-day"), localStorage.getItem("taviron-offline-outbox")])).toEqual([null, null]);
});
