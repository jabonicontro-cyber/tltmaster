import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { driverFixture, office } from "./driver-fixture";
import { signIn } from "./helpers";

/** A small real PNG (solid colour) so the phone-side re-encoding has something to decode. */
function png(width = 64, height = 48) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xc8)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test.use({ viewport: { width: 390, height: 844 } });

test("a driver attaches paper-ticket photos (with a failed upload and a retry) and the office views them", async ({ page }) => {
  const f = await driverFixture();
  await signIn(page, "driver");
  await page.goto(`/driver/assignments/${f.past}/ticket`);
  await page.getByLabel("Quantity on the ticket").fill("21.5");
  await page.getByLabel(/^Tons/).check();
  await page.getByLabel("Delivery time").fill("08:15");
  await page.getByLabel("Paper / scale ticket number").fill(f.ref);

  // First photo uploads; success shows only after the server confirms it.
  await page.locator("#ticket-photo").setInputFiles({ name: "ticket.png", mimeType: "image/png", buffer: png() });
  const photos = page.getByRole("list", { name: "Ticket photos" });
  await expect(photos.getByRole("listitem", { name: "Photo 1" })).toContainText("Uploaded");

  // Second photo without signal: clearly not uploaded, and the ticket cannot be sent until fixed.
  await page.context().setOffline(true);
  await page.locator("#ticket-photo").setInputFiles({ name: "back.png", mimeType: "image/png", buffer: png(40, 40) });
  const second = photos.getByRole("listitem", { name: "Photo 2" });
  await expect(second.getByRole("alert")).toContainText("Not uploaded — no connection");
  await page.getByRole("button", { name: "Send ticket" }).click();
  await expect(page.getByText("A photo did not upload. Tap Retry, or remove it.")).toBeVisible();
  await page.context().setOffline(false);
  await second.getByRole("button", { name: "Retry" }).click();
  await expect(second).toContainText("Uploaded");

  await page.getByRole("button", { name: "Send ticket" }).click();
  await expect(page).toHaveURL(/\/driver\?sent=/);
  const ticket = await office(async (q) => (await q("select id, ticket_number from public.delivery_tickets where external_reference = $1", [f.ref])).rows[0] as { id: string; ticket_number: string });
  const attached = await office(async (q) => (await q("select id from public.ticket_attachments where ticket_number = $1 order by attached_at", [ticket.ticket_number])).rows.map((r) => r.id as string));
  expect(attached).toHaveLength(2);

  // Drivers cannot open photos (office review only).
  expect((await page.request.get(`/tickets/photos/${attached[0]}`, { maxRedirects: 0 })).status()).toBe(403);

  // Direct upload attempts with the driver's own session.
  const origin = new URL(page.url()).origin;
  const post = (fields: Record<string, string | { name: string; mimeType: string; buffer: Buffer }>, headers: Record<string, string> = { origin }) =>
    page.request.post("/driver/photos", { multipart: fields, headers });
  const valid = { file: { name: "t.png", mimeType: "image/png", buffer: png() }, assignment_id: f.late, upload_key: crypto.randomUUID() };
  expect((await post(valid, {})).status()).toBe(403); // no Origin: refused
  expect((await post(valid, { origin: "https://evil.example" })).status()).toBe(403);
  expect((await post({ ...valid, upload_key: crypto.randomUUID(), assignment_id: f.otherAssignment })).status()).toBe(403); // another driver's load
  const disguised = await post({ ...valid, upload_key: crypto.randomUUID(), file: { name: "x.jpg", mimeType: "image/jpeg", buffer: Buffer.from("<html><script>alert(1)</script></html>") } });
  expect(disguised.status()).toBe(415);
  const mislabelled = await post({ ...valid, upload_key: crypto.randomUUID(), file: { name: "x.jpg", mimeType: "image/jpeg", buffer: png() } });
  expect(mislabelled.status()).toBe(415);
  const big = Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]);
  expect((await post({ ...valid, upload_key: crypto.randomUUID(), file: { name: "big.png", mimeType: "image/png", buffer: big } })).status()).toBe(413);

  // The office sees the photos in ticket review, through short-lived links.
  await page.context().clearCookies();
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page, "office");
  await page.goto(`/tickets?view=all&q=${ticket.ticket_number}`);
  await expect(page.getByRole("row").filter({ hasText: ticket.ticket_number }).getByText("Photo attached")).toBeAttached();
  await page.goto(`/tickets/${ticket.id}`);
  const gallery = page.getByRole("list", { name: "Paper ticket photos" });
  await expect(page.getByRole("heading", { name: "Paper ticket photos (2)" })).toBeVisible();
  const img = gallery.getByRole("img", { name: "Paper ticket photo 1" });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  const link = await page.request.get(`/tickets/photos/${attached[0]}`, { maxRedirects: 0 });
  expect(link.status()).toBe(302);
  expect(link.headers().location).toMatch(/\/storage\/v1\/object\/sign\/ticket-photos\/.+\?token=/);
  const file = await page.request.get(link.headers().location);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("image/jpeg"); // re-encoded on the phone
  expect((await page.request.get(`/tickets/photos/${crypto.randomUUID()}`)).status()).toBe(404);
  // B84: reviewers are offered the AI reading only when its gate is open; without AI it says so and nothing is sent.
  const reading = page.getByRole("region", { name: "Read the photo with AI" });
  await expect(reading).toContainText("AI ticket reading is not switched on for this company");
  await expect(reading.getByRole("button", { name: "Read the photo" })).toHaveCount(0);

  // A mechanic (no ticket access) cannot open it.
  await page.context().clearCookies();
  await signIn(page, "mechanic");
  expect((await page.request.get(`/tickets/photos/${attached[0]}`, { maxRedirects: 0 })).status()).toBe(403);
});
