import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Owner decisions 2026-11-16/17 (WK3), as people use them:
//  * stops: the place name suggests saved places (picking one fills the address), a stop outside the load's window is
//    warned about in plain words and still saves, and a typed place can be saved for next time;
//  * the assigned driver sees "Stop added" on My Day, with the new stops named;
//  * a shop job scheduled before its part arrives is flagged on the job, the overview, Shop capacity and the edit form,
//    with "Move to <arrival date>"; it moves only when the person presses it.

const setIndustry = (industry: string) =>
  asUser(USERS.owner.email, (q) => q("update public.company_settings set industry = $1 where company_id = (select private.current_company_id())", [industry]));
const companyToday = async () =>
  (await asUser(USERS.owner.email, (q) => q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d"))).rows[0].d as string;
const fmt = (d: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${d}T00:00:00Z`));
const plus = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

test("stops: saved places, a stop outside the load's window, save for next time, and the driver is told", async ({ browser }) => {
  test.slow();
  const fx = await driverFixture();
  const id = unique();
  const today = await companyToday();
  await setIndustry("freight");
  const yard = `North Yard (e2e ${id})`;
  const dock = `Receiver Dock (e2e ${id})`;
  try {
    await asUser(USERS.owner.email, async (q) => {
      const o = (await q("select scheduled_start::text s, scheduled_end::text e from public.orders where id = $1", [fx.orderId])).rows[0];
      await q("select public.update_order_schedule($1, null, $2::jsonb)", [fx.orderId, JSON.stringify({ scheduled_start: o.s, scheduled_end: o.e, window_start: "07:00", window_end: "14:00" })]);
      await q("insert into public.company_locations (kind, name, address_line1, city, state, postal_code) values ('yard', $1, '1 Yard Rd', 'Gary', 'IN', '46402')", [yard]);
    });
    const owner = await (await browser.newContext()).newPage();
    await signIn(owner, "owner");
    await owner.goto(`/orders/${fx.orderId}`);
    await owner.getByRole("button", { name: "Add stops" }).click();
    const form = owner.getByRole("form", { name: "Edit stops" });

    // Typing suggests the saved place; picking it fills the address.
    await form.getByLabel("Shipper or place").fill(`north yard e2e ${id}`);
    await owner.getByRole("option", { name: new RegExp(`North Yard \\(e2e ${id}\\)`) }).click();
    await expect(form.getByLabel("Shipper or place")).toHaveValue(yard);
    await expect(form.getByLabel("Street address").nth(0)).toHaveValue("1 Yard Rd");
    await expect(form.getByLabel("City").nth(0)).toHaveValue("Gary");
    await expect(form.getByText("Save this place for next time")).toHaveCount(0); // already saved

    // A typed receiver after the window: warned, offered to save, still saved.
    await form.getByLabel("Receiver or place").fill(dock);
    await form.getByLabel("City").nth(1).fill("Joliet");
    await form.getByLabel("State").nth(1).fill("IL");
    await form.getByLabel("Appointment date").nth(1).fill(today);
    await form.getByLabel("Window from").nth(1).fill("15:00");
    await form.getByLabel("Window to").nth(1).fill("16:00");
    await expect(form.getByText("This stop is after the load's window ends at 2:00 PM.")).toBeVisible();
    await form.getByLabel("Save this place for next time").check();
    await owner.screenshot({ path: "test-results/wk3-stop-editor.png" }).catch(() => {});
    await form.getByRole("button", { name: "Save stops" }).click();
    await expectToast(owner, /Stops saved\. Drivers see them on their load card\. Stop 2 is after the load's window ends at 2:00 PM\. 1 place saved for next time\./);
    const list = owner.getByRole("list", { name: "Stops" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(list.getByRole("listitem").nth(1)).toContainText("This stop is after the load's window ends at 2:00 PM.");
    const saved = await asUser(USERS.owner.email, (q) => q("select kind, city from public.company_locations where name = $1", [dock]));
    expect(saved.rows).toEqual([{ kind: "receiver", city: "Joliet" }]);

    // The assigned driver is told in the app, with the stops named.
    const driver = await (await browser.newContext()).newPage();
    await signIn(driver, "driver");
    await driver.goto("/driver");
    const updates = driver.getByRole("region", { name: "Updates from dispatch" });
    await expect(updates.getByText(new RegExp(`^2 stops added: ${fx.orderNumber} load \\d+ on `))).toBeVisible();
    await expect(updates.getByText(new RegExp(`Pickup at North Yard \\(e2e ${id}\\) \\(Gary, IN\\); Delivery at Receiver Dock \\(e2e ${id}\\) \\(Joliet, IL\\), .* 3:00 PM–4:00 PM`))).toBeVisible();
  } finally {
    await setIndustry("aggregate");
    await asUser(USERS.office.email, (q) => q("select public.save_order_stops($1, '[]'::jsonb)", [fx.orderId])).catch(() => {});
    await asUser(USERS.owner.email, (q) => q("update public.company_locations set active = false where name in ($1, $2)", [yard, dock])).catch(() => {});
  }
});

test("a shop job scheduled before its part arrives is flagged with a move offer, and moves only when asked", async ({ page }) => {
  test.slow();
  const id = unique();
  const today = await companyToday();
  const title = `Wiper motor (e2e ${id})`;
  const wo = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`WK3-${id}`])).rows[0].id as string;
    const r = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title, category: "electrical", scheduled_for: plus(today, 1) })])).rows[0].r as { id: string; number: string };
    await q("select public.part_wait_add($1, $2::jsonb)", [r.id, JSON.stringify({ description: "Wiper motor", expected_on: plus(today, 4) })]);
    return r;
  });
  const text = `Scheduled ${fmt(plus(today, 1))}, but Wiper motor is expected ${fmt(plus(today, 4))}.`;
  await signIn(page, "owner");

  // The overview's next 7 days and Shop capacity flag it.
  await page.goto("/maintenance");
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row.getByText(text)).toBeVisible();
  await page.goto("/maintenance/shop");
  const card = page.getByRole("list", { name: "Scheduled before their parts arrive" });
  await expect(card.getByRole("listitem").filter({ hasText: title }).getByText(text)).toBeVisible();
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${plus(today, 4)}T00:00:00Z`));
  await expect(page.getByText(`${wo.number}: part due ${short}`)).toBeVisible();

  // The edit form warns when the date is before the part.
  await page.goto(`/maintenance/work-orders/${wo.id}/edit`);
  await expect(page.getByText(`Wiper motor is expected ${fmt(plus(today, 4))}, after this date. You can still save it if the part will be in sooner.`)).toBeVisible();

  // On the job: nothing has moved until the person presses Move.
  await page.goto(`/maintenance/work-orders/${wo.id}`);
  const warning = page.getByTestId("part-arrival-warning");
  await expect(warning).toContainText(text);
  const before = await asUser(USERS.owner.email, (q) => q("select scheduled_for::text d from public.work_orders where id = $1", [wo.id]));
  expect(before.rows[0].d).toBe(plus(today, 1));
  await page.screenshot({ path: "test-results/wk3-part-arrival.png" }).catch(() => {});
  await warning.getByRole("button", { name: `Move to ${fmt(plus(today, 4))}` }).click();
  await expectToast(page, `${wo.number} moved to ${fmt(plus(today, 4))}, when its part is expected.`);
  await expect(page.getByTestId("part-arrival-warning")).toHaveCount(0);
  const after = await asUser(USERS.owner.email, (q) => q("select scheduled_for::text d, status from public.work_orders where id = $1", [wo.id]));
  expect(after.rows[0]).toEqual({ d: plus(today, 4), status: "scheduled" });
  await asUser(USERS.owner.email, (q) => q("select public.maintenance_set_status($1, 'canceled', 'e2e cleanup', null)", [wo.id])).catch(() => {});
});
