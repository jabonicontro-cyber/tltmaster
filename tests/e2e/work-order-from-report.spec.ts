import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Mechanic walkthrough (WK1): a work order made from a driver report starts with the truck, the report's words and its
// photos; the report then links to the job instead of offering Create again. Waiting for parts takes a note. On a
// phone the checklist and the job's actions are big enough to tap (44 px or more). Local stack only.

/** A small real PNG (solid colour). */
function png(width = 48, height = 36) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9a)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("a work order from a driver report starts with the truck, the words and the photos, and the report stops offering Create", async ({ page }) => {
  test.setTimeout(150_000);
  const f = await driverFixture();
  const tag = unique();
  const words = `Left mirror arm cracked ${tag}`;
  const reportId = await asUser(USERS.driver.email, async (q) =>
    ((await q("select public.driver_submit_field_report($1::jsonb) as r", [JSON.stringify({ assignment_id: f.late, kind: "equipment_issue", equipment: "truck", description: words, submission_key: crypto.randomUUID() })])).rows[0].r as { report_id: string }).report_id);

  // The driver adds a photo to the report, as the phone does after sending it.
  await signIn(page, "driver");
  const origin = new URL(page.url()).origin;
  const up = await page.request.post("/field-reports/photos", { multipart: { report: reportId, file: { name: "mirror.png", mimeType: "image/png", buffer: png() } }, headers: { origin } });
  expect(up.ok(), await up.text()).toBe(true);
  await page.context().clearCookies();

  await signIn(page, "owner");
  await page.goto(`/field-reports/${reportId}`);
  await page.getByRole("link", { name: "Create a work order" }).click();
  await expect(page).toHaveURL(/\/maintenance\/work-orders\/new\?truck=/);
  await expect(page.getByRole("list", { name: "Photos from the driver's report" }).getByRole("listitem")).toHaveCount(1);
  await expect(page.getByLabel("Description")).toHaveValue(new RegExp(words));
  await expect(page.getByRole("combobox", { name: "Truck", exact: true }).locator("option:checked")).toHaveText(new RegExp(f.myTruck));
  await page.getByRole("button", { name: "Create work order" }).click();
  await expectToast(page, /Work order MWO-\d{4,} created/);
  await page.waitForURL(/\/maintenance\/work-orders\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(words);
  const photos = page.getByRole("list", { name: "Photos from the driver's report" });
  await expect(photos.getByRole("listitem")).toHaveCount(1);
  const src = await photos.getByRole("img").getAttribute("src");
  expect((await page.request.get(src!, { maxRedirects: 0 })).status()).toBe(302); // opens through the report's signed link
  const woUrl = page.url();

  // The report now links to the job instead of offering a second one.
  await page.goto(`/field-reports/${reportId}`);
  await expect(page.getByRole("link", { name: /Work order MWO-\d{4,}/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create a work order" })).toHaveCount(0);

  // Waiting for parts takes an optional note; it shows in the job's Activity with the status change.
  await page.goto(woUrl);
  await page.getByRole("button", { name: "Waiting for parts" }).click();
  const dialog = page.getByRole("dialog", { name: "Waiting for parts" });
  await dialog.getByLabel("Which part?").fill(`Mirror arm ${tag}`);
  await dialog.getByLabel("Note (optional)").fill(`Ordered from the dealer, call when in ${tag}`);
  await dialog.getByRole("button", { name: "Mark waiting for parts" }).click();
  await expectToast(page, /Waiting for parts/);
  await page.goto(`${woUrl.split("?")[0]}?tab=activity`);
  const history = page.getByRole("list", { name: "History" });
  await expect(history).toContainText(`Ordered from the dealer, call when in ${tag}`);
  await expect(history).toContainText(`Part on order: Mirror arm ${tag}`);
  const status = await asUser(USERS.owner.email, async (q) => (await q("select status::text s from public.work_orders where field_report_id = $1", [reportId])).rows[0].s as string);
  expect(status).toBe("awaiting_parts");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the checklist and the job's actions are at least 44 px tall", async ({ page }) => {
    const tag = unique();
    const woId = await asUser(USERS.owner.email, async (q) => {
      const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`TAP-${tag}`])).rows[0].id as string;
      const wo = (await q("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify({ truck_id: truck, title: `Check wipers ${tag}`, category: "repair", urgency: "normal" })])).rows[0].r as { id: string };
      await q("select public.maintenance_add_task($1, $2)", [wo.id, "Replace both wiper blades"]);
      return wo.id;
    });
    await signIn(page, "mechanic");
    await page.goto(`/maintenance/work-orders/${woId}?tab=tasks`);
    const row = page.getByRole("list", { name: "Checklist" }).getByRole("button").first();
    await expect(row).toBeVisible();
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const name of ["Start work", "Waiting for parts"]) {
      const b = page.getByRole("button", { name, exact: true });
      await expect(b).toBeVisible();
      expect((await b.boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    }
  });
});
