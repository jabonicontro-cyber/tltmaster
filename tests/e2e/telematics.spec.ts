import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// GPS and hours (B101, migration 20261120004900): the owner turns on hand entry in Settings → GPS and hours, records a
// truck's location and a driver's hours on Fleet → Locations and hours, then switches to the provider feed, creates a
// feed key (shown once) and the feed endpoint accepts a position for that truck with it. The company is put back to
// "off" afterwards. Fictional data only.

const owner = <T,>(fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>) => Promise<T>) => asUser(USERS.owner.email, fn as never) as Promise<T>;

test("an owner records positions and hours by hand, then receives them from a provider feed", async ({ page, baseURL }) => {
  const id = unique();
  const unit = `GPS-${id}`;
  const driverName = `Gale Hours ${id}`;
  await owner(async (q) => {
    await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump')", [unit]);
    await q("insert into public.drivers (name) values ($1)", [driverName]);
  });
  try {
    await signIn(page, "owner");
    await page.goto("/settings?tab=gps");
    const form = page.getByRole("form", { name: "GPS and hours" });
    await form.getByRole("radio", { name: /^Entered by hand/ }).check();
    await form.getByRole("button", { name: "Save" }).click();
    await expectToast(page, "GPS and hours settings saved.");

    await page.goto("/fleet/locations");
    await page.getByRole("button", { name: "Record a location" }).click();
    const pos = page.getByRole("form", { name: "Record a location" });
    await pos.getByLabel("Truck").selectOption({ label: `Truck ${unit}` });
    await pos.getByLabel("Latitude").fill("40.4237");
    await pos.getByLabel("Longitude").fill("-86.9212");
    await pos.getByLabel("Note").fill("At the quarry scale");
    await pos.getByRole("button", { name: "Record location" }).click();
    await expectToast(page, "Location recorded.");
    const truckRow = page.getByRole("list", { name: "Truck positions" }).getByRole("listitem", { name: `Truck ${unit}` });
    await expect(truckRow).toContainText("40.4237, -86.9212");
    await expect(truckRow).toContainText("Entered by hand");

    await page.getByRole("button", { name: "Record hours" }).click();
    const hrs = page.getByRole("form", { name: "Record hours" });
    await hrs.getByLabel("Driver").selectOption({ label: driverName });
    await hrs.getByLabel("Duty status").selectOption("driving");
    await hrs.getByLabel("Drive left").fill("5:30");
    await hrs.getByLabel("Shift left").fill("7");
    await hrs.getByRole("button", { name: "Record hours" }).click();
    await expectToast(page, "Hours recorded.");
    const driverRow = page.getByRole("list", { name: "Drivers' hours" }).getByRole("listitem", { name: driverName });
    await expect(driverRow).toContainText("Drive 5 h 30 min");
    await expect(driverRow).toContainText("Shift 7 h");
    await expect(driverRow).not.toContainText("Verified for today");

    // Provider feed: a key shown once; the endpoint refuses a wrong key and accepts the real one.
    await page.goto("/settings?tab=gps");
    await page.getByRole("radio", { name: /^Provider feed/ }).check();
    await page.getByRole("form", { name: "GPS and hours" }).getByRole("button", { name: "Save" }).click();
    await expectToast(page, "GPS and hours settings saved.");
    await page.getByRole("button", { name: "Create feed key" }).click();
    const key = await page.getByRole("textbox", { name: "Feed key" }).inputValue();
    expect(key).toMatch(/^tlk_[0-9a-f]{40}$/);
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText(`…${key.slice(-4)}`)).toBeVisible();

    const endpoint = `${baseURL}/api/telematics/ingest`;
    const body = { positions: [{ truck: unit, latitude: 40.5, longitude: -86.8, speed_mph: 37 }], hours: [{ driver: driverName, duty_status: "driving", drive_minutes_left: 200, shift_minutes_left: 300 }] };
    expect((await page.request.post(endpoint, { data: body, headers: { authorization: `Bearer tlk_${"0".repeat(40)}` } })).status()).toBe(401);
    const res = await page.request.post(endpoint, { data: body, headers: { authorization: `Bearer ${key}` } });
    expect(res.status()).toBe(200);
    expect((await res.json()).accepted).toMatchObject({ positions: 1, hours: 1 });

    await page.goto("/fleet/locations");
    await expect(truckRow).toContainText("Provider feed");
    await expect(truckRow).toContainText("37 mph");
    await expect(driverRow).toContainText("Verified for today");
  } finally {
    await owner(async (q) => {
      await q("select public.telematics_revoke_feed_key()");
      await q("select public.telematics_save_settings('none', 30)");
      await q("update public.trucks set active = false where unit_number = $1", [unit]);
      await q("update public.drivers set active = false where name = $1", [driverName]);
    });
  }
});
