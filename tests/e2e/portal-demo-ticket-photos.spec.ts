import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { signInPlatform } from "./helpers";

// Sample ticket photos for demo customers (UX13, 20261120020900): after Refresh demo data, a demo customer's portal
// (Testing Lab preview) shows a photo on their latest confirmed ticket: a fictional image stamped SAMPLE, served from
// the private ticket-photos store through the portal's own short signed link, like a driver's photo. A real company's
// tickets never get one. Screenshots go to E2E_SCREENSHOTS when set.

const SHOTS = process.env.E2E_SCREENSHOTS;

async function sql<T extends pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

test("a demo customer's portal shows the sample photo of their confirmed ticket after Refresh", async ({ browser }) => {
  test.setTimeout(480_000);
  const installed = (await sql<{ ok: boolean }>("select to_regprocedure('public.demo_ticket_photo_targets()') is not null ok"))[0].ok;
  test.skip(!installed, "Needs migration 20261120020900.");
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
  await signInPlatform(page);
  await page.goto("/admin/testing-lab");
  const presenter = await page.getByLabel("Demo company").locator("option", { hasText: "presenter demo" }).first().getAttribute("value").catch(() => null);
  test.skip(!presenter, "No presenter demo on this database (created by platform.spec).");

  // Refresh the presenter demo the operator's way: the shared samples add the photos (once).
  await page.goto("/admin/demo");
  await page.getByRole("button", { name: "Refresh demo data" }).first().click();
  await page.waitForURL(/saved=refreshed/, { timeout: 300_000 });
  const photos = await sql<{ ticket_id: string; order_id: string; customer: string; customer_id: string }>(
    `select a.ticket_id, t.order_id, c.name customer, c.id customer_id
       from public.ticket_attachments a join public.delivery_tickets t on t.id = a.ticket_id join public.orders o on o.id = t.order_id
       join public.customers c on c.id = o.customer_id
      where a.company_id = $1 and a.status = 'attached' and a.upload_key = md5('demo-ticket-photo:' || a.ticket_id::text)::uuid
      order by c.name`, [presenter]);
  expect(photos.length).toBeGreaterThan(0);
  expect(new Set(photos.map((p) => p.customer_id)).size).toBe(photos.length);
  // Never in a real company.
  expect((await sql<{ n: string }>(
    "select count(*) n from public.ticket_attachments a join public.companies co on co.id = a.company_id where not co.is_demo and a.upload_key = md5('demo-ticket-photo:' || a.ticket_id::text)::uuid"))[0].n).toBe("0");

  // Preview the portal as a demo customer that has one, and open that ticket.
  const target = photos.find((p) => p.customer === "Cedar Ridge Builders (demo)") ?? photos[0];
  await page.goto(`/admin/testing-lab?demo=${presenter}`);
  const turnOn = page.getByRole("button", { name: "Turn On Demo Portal" });
  if (await turnOn.isVisible()) {
    await turnOn.click();
    await expect(page.getByRole("button", { name: "Preview as Customer" })).toBeVisible();
  }
  await page.getByLabel("Demo customer").selectOption(target.customer_id);
  await page.getByRole("button", { name: "Preview as Customer" }).click();
  await page.waitForURL(/\/portal\/[a-z0-9-]+$/);
  const slug = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`/portal/${slug}/orders/${target.order_id}/tickets/${target.ticket_id}`);
  const section = page.getByRole("region", { name: "Ticket photos" });
  await expect(section).toBeVisible();
  const img = section.getByRole("img", { name: "Ticket photo 1" });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(800);
  // The photo comes from the private store through a short signed link, as a real one does.
  const res = await page.request.get(`/portal/${slug}/ticket-photos/${await img.getAttribute("src").then((s) => s!.split("/").pop())}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"]).toMatch(/ticket-photos/);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/ux13-portal-ticket-photo.png` });
  }
  await page.getByRole("button", { name: "End Preview" }).click().catch(() => undefined);
});
