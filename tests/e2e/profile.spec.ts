import { expect, test } from "@playwright/test";
import { signIn, expectToast } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Self-service profile: photo (resized in the browser), display name and phone.
// Role, company and full name stay with the company; photos never cross companies.

/** A real 400×300 PNG drawn in the page, so the browser's resize path is exercised. */
async function pngFile(page: import("@playwright/test").Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const x = c.getContext("2d")!;
    x.fillStyle = "#168bff";
    x.fillRect(0, 0, 400, 300);
    x.fillStyle = "#ffffff";
    x.fillRect(150, 100, 100, 100);
    return c.toDataURL("image/png").split(",")[1];
  });
  return Buffer.from(b64, "base64");
}

test.afterAll(async () => {
  // Leave the shared test accounts as they were.
  for (const who of ["driver", "office"] as const) {
    await asUser(USERS[who].email, (q) => q("select public.update_my_profile('', ''), public.set_my_photo(null, null)"));
  }
});

test("a driver adds, replaces and removes their photo, sets a display name, and is greeted by it", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "My profile", level: 1 })).toBeVisible();
  // Role and company are shown, not editable.
  await expect(page.getByRole("heading", { name: "Managed by your company" })).toBeVisible();
  await expect(page.getByLabel("Role")).toHaveCount(0);

  // Phone validation: the error is explained and the typed values stay.
  await page.getByLabel("Name to show").fill("Danny D");
  await page.getByLabel("Phone").fill("3125");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Enter the whole number, e.g. (312) 555-0142, or leave it empty.")).toBeVisible();
  await expect(page.getByLabel("Phone")).toHaveValue("(312) 5");
  await expect(page.getByLabel("Name to show")).toHaveValue("Danny D");
  await page.getByLabel("Phone").fill("+1 (555) 010-2000");
  await page.getByRole("button", { name: "Save" }).click();
  await expectToast(page, "Profile saved.");

  // Photo: picked, resized in the browser to a 256 px square, saved.
  await page.locator("#photo").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: await pngFile(page) });
  await expectToast(page, "Photo saved.");
  const stored = await asUser(USERS.driver.email, async (q) => (await q("select mime_type, length(data_base64) as len from public.profile_photo((public.my_profile()->>'user_id')::uuid)")).rows[0]);
  expect(stored.mime_type).toBe("image/jpeg"); // re-encoded, metadata dropped
  expect(Number(stored.len)).toBeLessThan(200 * 1024 * 1.4);

  // The header shows the photo; My Day greets by the display name.
  await page.goto("/driver");
  await expect(page.getByTestId("greeting")).toHaveText("Hi, Danny!");
  await expect(page.locator("header img[src^='/people/photo/']")).toBeVisible();

  // Remove (with confirmation): initials again.
  await page.goto("/profile");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Remove" }).click();
  await expectToast(page, "Photo removed.");
  await page.reload();
  await expect(page.locator("header img[src^='/people/photo/']")).toHaveCount(0);
});

test("a wrong file type is refused with a reason", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/profile");
  await page.locator("#photo").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(page.getByText("Choose a photo (JPEG, PNG, WebP or a phone camera picture).")).toBeVisible();
});

test("photos stay inside the company: colleagues see them, other companies and signed-out visitors do not", async ({ page, browser }) => {
  const driverId = await asUser(USERS.driver.email, async (q) => (await q("select (public.my_profile()->>'user_id') as id")).rows[0].id as string);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  await asUser(USERS.driver.email, (q) => q("select public.set_my_photo('image/png', $1)", [png.toString("base64")]));

  await signIn(page, "office");
  const mine = await page.request.get(`/people/photo/${driverId}`);
  expect(mine.status()).toBe(200);
  expect(mine.headers()["content-type"]).toBe("image/png");

  const other = await browser.newPage();
  await signIn(other, "otherOwner");
  expect((await other.request.get(`/people/photo/${driverId}`)).status()).toBe(404);
  await other.close();

  const anon = await browser.newContext();
  const r = await anon.request.get(`/people/photo/${driverId}`, { maxRedirects: 0 });
  expect([302, 303, 307, 401]).toContain(r.status());
  await anon.close();
});
