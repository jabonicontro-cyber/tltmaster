import { expect, test, type Locator } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Shift scheduling (20261120003300): a dispatcher sets a driver's weekly schedule and a day off on the Schedule page;
// assigning that driver a load on the day off is stopped with the reason and goes through only with a written reason.

async function choose(select: Locator, prefix: string) {
  const value = await select.locator("option", { hasText: prefix }).first().getAttribute("value");
  await select.selectOption(value!);
}

/** A Monday well ahead (a different one per run, so runs do not share a day). */
function futureMonday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30 + Math.floor(Math.random() * 300));
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

test("a dispatcher schedules a driver, gives a day off, and assigning on that day needs a reason", async ({ page }) => {
  test.slow();
  const id = unique();
  const monday = futureMonday();
  const name = `Shift Driver ${id}`;
  const truck = `SHF-${id}`.slice(0, 20);
  const { orderNumber } = await asUser(USERS.owner.email, async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const verified = new Date().toISOString();
    await ins("trucks", { unit_number: truck, truck_type: "tri_axle_dump", weight_capacity: "22", weight_unit: "ton", capacity_verified_at: verified });
    const d = await ins("drivers", { name });
    await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: "2030-01-01", verified_at: verified });
    await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: "2030-01-01", verified_at: verified });
    await ins("employees", { full_name: name, department: "operations", driver_id: d });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({ customer_id: cust.rows[0].id, project_name: `Schedule e2e ${id}`, site_line1: "42 Sample Lane", site_city: "Crown Point", lines: [{ kind: "other", calc_method: "per_unit", description: "Hauling (e2e)", unit_code: "load", quantity: "1", unit_rate_cents: 10000 }] })]);
    const orderId = r.rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [orderId]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [orderId, JSON.stringify({ scheduled_start: monday, window_start: "07:00", window_end: "15:00" })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [orderId]);
    await q("select public.save_order_load($1::jsonb)", [JSON.stringify({ order_id: orderId, load_date: monday, start_time: "08:00", end_time: "10:00" })]);
    return { orderNumber: r.rows[0].r.order_number as string };
  });

  await signIn(page, "dispatcher");
  await page.goto(`/schedule?week=${monday}&q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("heading", { name: "Schedule", level: 1 })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("No repeating schedule");

  // Weekly schedule from this Monday (the dialog proposes Monday–Friday 6:00–16:30).
  await row.getByRole("button", { name: `Set ${name}'s schedule` }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Starts on")).toHaveValue(monday);
  await dialog.getByRole("button", { name: "Save schedule" }).click();
  await expectToast(page, "Schedule saved.");
  await expect(row).toContainText("Weekly");
  await expect(row.getByRole("button", { name: /6a–4:30p/ }).first()).toBeVisible();

  // Monday off, with a reason.
  await row.getByRole("button", { name: new RegExp(`^${name}, .*: 6a–4:30p\\. Change$`) }).first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Day off").check();
  await dialog.getByLabel("Reason (optional)").fill("Dentist (e2e)");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expectToast(page, "Day off saved.");
  await expect(row.getByRole("button", { name: /day off, changed for this day/ })).toHaveCount(1);

  // Dispatch: assigning the driver on their day off asks for a reason.
  // The staffing forecast counts the week's planned loads; the day view draws each shift on a 24-hour timeline (SCH-1).
  await expect(page.getByRole("region", { name: "Staffing forecast" }).getByRole("listitem", { name: /^Mon: \d+ drivers? on shift, [1-9]\d* loads? planned/ })).toBeVisible();
  await page.getByRole("group", { name: "View" }).getByRole("link", { name: "Day" }).click();
  await page.getByRole("navigation", { name: "Day" }).getByRole("link", { name: /^Tue/ }).click();
  await expect(page.getByRole("listitem", { name: `${name}: 6a–4:30p` })).toBeVisible();
  await page.getByRole("navigation", { name: "Day" }).getByRole("link", { name: /^Mon/ }).click();
  await expect(page.getByRole("listitem", { name: `${name}: Day off` })).toBeVisible();

  await page.goto(`/dispatch?date=${monday}`);
  const card = page.locator("section").filter({ has: page.getByRole("link", { name: orderNumber, exact: true }) });
  await card.getByRole("listitem", { name: "Load 1", exact: true }).getByRole("button", { name: "Assign", exact: true }).click();
  dialog = page.getByRole("dialog");
  await choose(dialog.getByLabel("Truck"), truck);
  await choose(dialog.getByLabel("Driver"), name);
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: /^Day off on Mon/ })).toBeVisible();
  const anyway = dialog.getByRole("button", { name: "Assign anyway" });
  await expect(anyway).toBeDisabled();
  await dialog.getByLabel("Reason for working outside the shift").fill("Covering a rush pour (e2e)");
  await anyway.click();
  await expectToast(page, "Load assigned.");
});

test("My Day shows the driver's own shift", async ({ page }) => {
  // Yesterday, today and tomorrow in UTC, so the company's today is covered in any time zone; cleared afterwards.
  const days = [-1, 0, 1].map((n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10));
  const employee = await asUser(USERS.owner.email, async (q) => {
    const e = (await q("select e.id from public.employees e join auth.users u on u.id = e.user_id where u.email = $1", [USERS.driver.email])).rows[0].id as string;
    for (const d of days) await q("select public.schedule_set_day($1, $2, 'shift', '00:00', '23:45', 0, 'My Day check (e2e)')", [e, d]);
    return e;
  });
  try {
    await signIn(page, "driver");
    await page.goto("/driver");
    await expect(page.getByTestId("my-shift")).toContainText("Your shift: 12:00 AM – 11:45 PM");
  } finally {
    await asUser(USERS.owner.email, async (q) => { for (const d of days) await q("select public.schedule_clear_day($1, $2)", [employee, d]); });
  }
});

test("drivers cannot open the Schedule page", async ({ page }) => {
  await signIn(page, "driver");
  await page.goto("/schedule");
  await expect(page).toHaveURL(/no-access/);
});

// Time off on the Schedule (owner 2026-10-26): pending, approved and denied requests show on the person's days.
test("the week shows a person's pending, approved and denied time off", async ({ page }) => {
  const monday = futureMonday();
  const day = (n: number) => { const d = new Date(`${monday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const name = `Time Off Person ${unique()}`;
  await asUser(USERS.owner.email, async (q) => {
    const emp = (await q("insert into public.employees (full_name, department) values ($1, 'operations') returning id", [name])).rows[0].id as string;
    const save = async (category: string, date: string) => (await q("select public.time_off_save($1::jsonb) as r", [JSON.stringify({ employee_id: emp, category, start_date: date, end_date: date, hours: 8 })])).rows[0].r.id as string;
    await save("unpaid", day(0));
    await q("select public.time_off_decide($1, 'approved', '')", [await save("sick", day(1))]);
    await q("select public.time_off_decide($1, 'denied', 'Two crews already off.')", [await save("other", day(2))]);
  });
  await signIn(page, "owner");
  await page.goto(`/schedule?week=${monday}&q=${encodeURIComponent(name)}`);
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByRole("link", { name: "Unpaid leave time off: pending" })).toBeVisible();
  await expect(row.getByRole("link", { name: "Sick time off: approved" })).toBeVisible();
  await expect(row.getByRole("link", { name: "Other time off: denied" })).toBeVisible();
});
