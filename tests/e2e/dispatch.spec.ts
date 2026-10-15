import { expect, test, type Locator } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

/** Select the option whose text starts with the unit number or name. */
async function choose(select: Locator, prefix: string) {
  const value = await select.locator("option", { hasText: prefix }).first().getAttribute("value");
  await select.selectOption(value!);
}

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Fixture {
  date: string;
  orderId: string;
  orderNumber: string;
  dump: string;
  down: string;
  tractor: string;
  trailer: string;
  driverA: string;
  driverB: string;
  expired: string;
}

/** Fictional fleet and one Scheduled order, created through the app's own database functions. */
async function fixture(): Promise<Fixture> {
  const id = unique();
  const date = plusDays(20 + (Date.now() % 200));
  const far = plusDays(600);
  return asUser(USERS.office.email, async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
      return r.rows[0].id as string;
    };
    const verified = new Date().toISOString();
    const dump = `DSP-${id}`;
    const down = `DWN-${id}`;
    const tractor = `TRC-${id}`;
    const trailer = `TLR-${id}`;
    await ins("trucks", { unit_number: dump, truck_type: "tri_axle_dump" });
    const downId = await ins("trucks", { unit_number: down, truck_type: "tri_axle_dump" });
    await q("select public.set_equipment_service_status('truck', $1, 'out_of_service', 'Brake repair (e2e)')", [downId]);
    await ins("trucks", { unit_number: tractor, truck_type: "tractor" });
    await ins("trailers", { unit_number: trailer, trailer_type: "end_dump", compatible_truck_types: "{tractor}" });
    const names = { driverA: `Avery Driver ${id}`, driverB: `Blake Driver ${id}`, expired: `Casey Expired ${id}` };
    for (const [key, name] of Object.entries(names)) {
      const d = await ins("drivers", { name });
      await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
      await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: key === "expired" ? plusDays(-1) : far, verified_at: verified });
    }
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({ customer_id: cust.rows[0].id, project_name: `Dispatch e2e ${id}`, site_line1: "42 Sample Lane", site_city: "Crown Point", lines: [{ kind: "other", calc_method: "per_unit", description: "Hauling (e2e)", unit_code: "load", quantity: "2", unit_rate_cents: 10000 }] }),
    ]);
    const orderId = r.rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [orderId]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [orderId, JSON.stringify({ scheduled_start: date, window_start: "07:00", window_end: "15:00" })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [orderId]);
    return { date, orderId, orderNumber: r.rows[0].r.order_number as string, dump, down, tractor, trailer, ...names };
  });
}

test("dispatcher plans loads, assigns, sees conflicts and unavailable resources, reassigns and removes", async ({ page }) => {
  // A long workflow on the board; with the test database's accumulated trucks and drivers it can exceed 60 s on the dev server.
  test.slow();
  const f = await fixture();
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${f.date}`);
  const card = page.locator("div").filter({ has: page.getByRole("link", { name: f.orderNumber, exact: true }) }).filter({ has: page.getByRole("button", { name: "Add load" }) }).last();
  await expect(card.getByText("Crown Point").first()).toBeVisible();

  // Load 1, 7:00–9:00, 22 tons
  await card.getByRole("button", { name: "Add load" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Start").fill("07:00");
  await dialog.getByLabel("End").fill("09:00");
  await dialog.getByLabel("Planned quantity").fill("22");
  await dialog.getByLabel("Unit").selectOption({ label: "Tons" });
  await dialog.getByRole("button", { name: "Add load" }).click();
  await expectToast(page, "Load 1 added.");
  // Scoped to this test's order (its card): earlier runs on the same date leave their own "Load 1" on the board.
  const orderCard = page.locator("section").filter({ has: page.getByRole("link", { name: f.orderNumber, exact: true }) });
  const load1 = orderCard.getByRole("listitem", { name: "Load 1", exact: true }).filter({ hasText: "22 ton" });
  await expect(load1.getByText("Needs a truck and driver")).toBeVisible();

  // Assign the dump truck and driver A.
  await load1.getByRole("button", { name: "Assign", exact: true }).click();
  dialog = page.getByRole("dialog");
  await choose(dialog.getByLabel("Truck"), f.dump);
  await choose(dialog.getByLabel("Driver"), f.driverA);
  await expect(dialog.getByText("This combination can be assigned.")).toBeVisible();
  await expect(dialog.getByText("Note: Truck capacity is not recorded.")).toBeVisible();
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  await expectToast(page, "Load assigned.");
  await expect(load1.getByText(f.dump)).toBeVisible();

  // Load 2 overlaps 8:00–10:00
  await card.getByRole("button", { name: "Add load" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Start").fill("08:00");
  await dialog.getByLabel("End").fill("10:00");
  await dialog.getByRole("button", { name: "Add load" }).click();
  await expectToast(page, "Load 2 added.");
  const load2 = orderCard.getByRole("listitem", { name: "Load 2", exact: true });
  await load2.getByRole("button", { name: "Assign", exact: true }).click();
  dialog = page.getByRole("dialog");

  // Already assigned (busy) is distinguished from unavailable.
  const truckSelect = dialog.getByLabel("Truck");
  await expect(truckSelect.locator("optgroup[label='Already assigned at this time'] option", { hasText: f.dump })).toHaveCount(1);
  await expect(truckSelect.locator("optgroup[label='Unavailable'] option", { hasText: f.down })).toHaveCount(1);
  await expect(dialog.getByLabel("Driver").locator("optgroup[label='Unavailable'] option", { hasText: f.expired })).toHaveCount(1);
  await choose(truckSelect, f.dump);
  await choose(dialog.getByLabel("Driver"), f.driverB);
  await expect(dialog.getByText(/Already assigned: the truck is booked 7:00 AM – 9:00 AM/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Assign", exact: true })).toBeDisabled();
  await choose(truckSelect, f.down);
  await expect(dialog.getByText("Unavailable: Truck is out of service.")).toBeVisible();
  await choose(truckSelect, f.tractor);
  await expect(dialog.getByText("Unavailable: A tractor needs a trailer for this load.")).toBeVisible();
  await choose(dialog.getByLabel("Trailer"), f.trailer);
  await expect(dialog.getByText("This combination can be assigned.")).toBeVisible();
  await dialog.getByRole("button", { name: "Assign", exact: true }).click();
  await expectToast(page, "Load assigned.");
  await expect(load2.getByText(f.tractor)).toBeVisible();

  // Reassign load 1 to driver... B is busy now; the server refuses a stale overlap too.
  await load1.getByRole("button", { name: "Reassign" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Driver").locator("optgroup[label='Already assigned at this time'] option", { hasText: f.driverB })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Remove load 1's assignment with a reason → history kept.
  await load1.getByRole("button", { name: "Remove assignment from load 1" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Remove assignment" }).click();
  await expect(dialog.getByText(/reason/i).first()).toBeVisible();
  await dialog.getByLabel("Reason").fill("Customer pushed to the afternoon (e2e)");
  await dialog.getByRole("button", { name: "Remove assignment" }).click();
  await expectToast(page, "Assignment removed.");
  await expect(load1.getByText("Needs a truck and driver")).toBeVisible();
  await expect(load1.getByText("History (1 earlier)")).toBeVisible();

  // The order page shows loads and the history.
  await page.getByRole("link", { name: f.orderNumber, exact: true }).first().click();
  await expect(page.getByRole("list", { name: "Loads" }).getByText("Needs a truck")).toBeVisible();
  const history = page.getByRole("list", { name: "Order history" });
  await expect(history.getByText(/load 1 assigned: truck/)).toBeVisible();
  await expect(history.getByText(/load 1 unassigned/)).toBeVisible();
});

test("people without dispatch permission cannot open the board", async ({ page }) => {
  await signIn(page, "mechanic");
  await page.goto("/dispatch");
  await expect(page).toHaveURL(/no-access/);
});
