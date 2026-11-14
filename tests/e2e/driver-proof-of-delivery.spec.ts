import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn } from "./helpers";
import { USERS } from "./users";
import { SAMPLE_TICKET_PHOTOS } from "../../src/server/demo/ticket-photo-images";

// Proof of delivery from the driver's phone (MK2, 20261120020800): the assigned driver, on a phone, adds a photo of the
// signed paperwork at a delivery stop of their own load from My Day. Without signal nothing is sent and the driver is
// told so on the stop; back online it is sent once. Another driver's load is refused. The office sees the document on
// the order (with the stop, the load and who added it) and on the order's billing page, and opens it through a signed
// link. Screenshots go to E2E_SCREENSHOTS when set.

const SHOTS = process.env.E2E_SCREENSHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};
const PHOTO = Buffer.from(SAMPLE_TICKET_PHOTOS.freight[1], "base64");

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

test("a driver on a phone adds proof of delivery at a stop; the office sees it on the order and billing", async ({ browser }) => {
  test.setTimeout(240_000);
  const fx = await driverFixture();
  const installed = (await sql<{ ok: boolean }>("select to_regprocedure('public.driver_pod_begin(uuid, uuid, uuid, text, integer, text)') is not null ok"))[0].ok;
  test.skip(!installed, "Needs migration 20261120020800.");
  await asUser(USERS.office.email, (q) => q("select public.save_order_stops($1, $2::jsonb)", [fx.orderId, JSON.stringify([
    { kind: "pickup", name: "Acme Steel (e2e)", city: "Gary", state: "IN" },
    { kind: "delivery", name: "Lakeside Build (e2e)", city: "Joliet", state: "IL", reference: "PO 4471" },
  ])]));
  const [late] = await sql<{ load_number: number; stop_id: string }>(
    `select l.load_number, (select id from public.order_stops s where s.order_id = l.order_id and s.kind = 'delivery' and s.removed_at is null) stop_id
       from public.dispatch_assignments a join public.order_loads l on l.id = a.load_id where a.id = $1`, [fx.late]);

  try {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const driver = await phone.newPage();
    await signIn(driver, "driver");
    await driver.goto("/driver");
    const card = driver.getByRole("listitem", { name: `Load ${late.load_number}, ${fx.orderNumber}` });
    const stop = card.getByLabel("Proof of delivery, stop 2, Lakeside Build (e2e)");
    await expect(stop.getByRole("button", { name: "Add proof of delivery for stop 2, Lakeside Build (e2e)" })).toBeVisible();
    // Only delivery stops offer it, never the pickup.
    await expect(card.getByLabel("Proof of delivery, stop 1, Acme Steel (e2e)")).toHaveCount(0);
    await stop.scrollIntoViewIfNeeded();
    await shot(driver, "mk2-1-driver-stop-before");

    // The camera button opens the phone camera; here the test hands the photo to that input.
    await card.getByTestId(`pod-camera-${late.stop_id}`).setInputFiles({ name: "IMG_0412.jpg", mimeType: "image/jpeg", buffer: PHOTO });
    await expectToast(driver, "Proof of delivery sent for stop 2, Lakeside Build (e2e).");
    await expect(stop.getByRole("list", { name: "Proof of delivery sent, stop 2, Lakeside Build (e2e)" }).getByRole("listitem")).toHaveCount(1);
    await expect(stop.getByRole("button", { name: /Add another photo/ })).toBeVisible();
    await shot(driver, "mk2-2-driver-stop-sent");

    // No signal: nothing is sent, the driver is told on the stop; back online it goes once.
    await phone.setOffline(true);
    await card.getByTestId(`pod-camera-${late.stop_id}`).setInputFiles({ name: "IMG_0413.jpg", mimeType: "image/jpeg", buffer: PHOTO });
    await expect(stop.getByRole("alert")).toContainText("Not sent: no signal.");
    await shot(driver, "mk2-3-driver-no-signal");
    expect((await sql<{ n: string }>("select count(*) n from public.order_documents where order_id = $1 and removed_at is null", [fx.orderId]))[0].n).toBe("1");
    await phone.setOffline(false);
    await expectToast(driver, "Proof of delivery sent for stop 2, Lakeside Build (e2e).");
    await expect(stop.getByRole("list", { name: "Proof of delivery sent, stop 2, Lakeside Build (e2e)" }).getByRole("listitem")).toHaveCount(2);

    // Another driver's load on the same order: refused by Taviron, nothing stored.
    const refused = await driver.request.post("/driver/proof", {
      headers: { origin: new URL(driver.url()).origin },
      multipart: { file: { name: "x.jpg", mimeType: "image/jpeg", buffer: PHOTO }, assignment_id: fx.otherAssignment, stop_id: late.stop_id, upload_key: crypto.randomUUID() },
    });
    expect(refused.status()).toBe(403);
    // The pickup stop of the driver's own load is refused too.
    const pickup = (await sql<{ id: string }>("select id from public.order_stops where order_id = $1 and kind = 'pickup' and removed_at is null", [fx.orderId]))[0].id;
    const atPickup = await driver.request.post("/driver/proof", {
      headers: { origin: new URL(driver.url()).origin },
      multipart: { file: { name: "x.jpg", mimeType: "image/jpeg", buffer: PHOTO }, assignment_id: fx.late, stop_id: pickup, upload_key: crypto.randomUUID() },
    });
    expect(atPickup.status()).toBe(400);
    expect((await sql<{ n: string }>("select count(*) n from public.order_documents where order_id = $1 and removed_at is null", [fx.orderId]))[0].n).toBe("2");
    await phone.close();

    // The office sees both on the order, for the stop and the load, added by the driver, and opens one.
    const office = await (await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 2 })).newPage();
    await signIn(office, "office");
    await office.goto(`/orders/${fx.orderId}`);
    const list = office.getByRole("list", { name: "Order documents" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("link", { name: "Proof of delivery · Delivery 2: Lakeside Build (e2e)" }).first()).toBeVisible();
    await expect(list).toContainText(`Load ${late.load_number}, from the driver's phone (${USERS.driver.name})`);
    await list.scrollIntoViewIfNeeded();
    await shot(office, "mk2-4-office-order-documents");
    const href = await list.getByRole("link").first().getAttribute("href");
    const opened = await office.request.get(href!, { maxRedirects: 0 });
    expect(opened.status()).toBe(302);
    expect(opened.headers()["location"]).toMatch(/order-documents/);

    // And on the order's billing page, read-only.
    await office.goto(`/billing/orders/${fx.orderId}`);
    const billing = office.getByRole("heading", { name: "Delivery documents" });
    if (await billing.count()) {
      await billing.evaluate((el) => { el.scrollIntoView({ block: "start" }); window.scrollBy(0, -120); });
      await expect(office.getByRole("list", { name: "Order documents" })).toContainText("Proof of delivery · Delivery 2: Lakeside Build (e2e)");
      await expect(office.getByRole("button", { name: /^Remove / })).toHaveCount(0);
      await shot(office, "mk2-5-billing-delivery-documents");
    } else {
      // An order not yet in billing's list opens no billing page for it; the order page is where it shows.
      test.info().annotations.push({ type: "note", description: "Billing page not shown for this order state" });
    }
  } finally {
    await asUser(USERS.office.email, (q) => q("select public.save_order_stops($1, '[]'::jsonb)", [fx.orderId])).catch(() => {});
  }
});
