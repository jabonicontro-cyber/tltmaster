import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A scheduled order with yesterday's load assigned to a qualified driver. */
async function fixture() {
  const id = unique();
  return asUser(USERS.office.email, async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
      return r.rows[0].id as string;
    };
    // Business "today" in the company's timezone (company settings are readable by members).
    const today = (await q("select (now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const truck = `TKT-${id}`;
    const driverName = `Riley Ticket ${id}`;
    const truckId = await ins("trucks", { unit_number: truck, truck_type: "tri_axle_dump" });
    const driverId = await ins("drivers", { name: driverName });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driverId, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
    await ins("driver_qualifications", { driver_id: driverId, kind: "medical_card", expires_on: plusDays(600), verified_at: verified });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({
        site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id,
        order_date: yesterday,
        project_name: `Tickets e2e ${id}`,
        lines: [
          { kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 },
          { kind: "other", calc_method: "per_unit", description: "Hauling (e2e)", unit_code: "load", quantity: "2", unit_rate_cents: 10000 },
        ],
      }),
    ]);
    const orderId = r.rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [orderId]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [orderId, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [orderId]);
    const load = await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: orderId, load_date: yesterday, start_time: "07:00", end_time: "09:00", planned_quantity: "22", unit_code: "ton" })]);
    const loadId = load.rows[0].r.load_id as string;
    await q("select public.assign_load($1, $2, null, $3, '', null)", [loadId, truckId, driverId]);
    return { orderId, orderNumber: r.rows[0].r.order_number as string, loadId, yesterday, truck, driverName, paper: `SC-${id}` };
  });
}

test("enter a ticket from paper, correct it, review it, and guard against a duplicate", async ({ page }) => {
  const f = await fixture();

  // Dispatcher enters the paper ticket.
  await signIn(page, "dispatcher");
  await page.goto("/tickets");
  const row = page.getByRole("row").filter({ hasText: f.orderNumber });
  await expect(row.getByText(f.truck)).toBeVisible();
  await row.getByRole("link", { name: "Enter ticket" }).click();
  await expect(page.getByRole("heading", { name: `Ticket for ${f.orderNumber} load 1` })).toBeVisible();

  await page.getByLabel("Order line").selectOption({ label: "Gravel #53 limestone — ordered 44 tons" });
  await page.getByLabel("Delivered quantity").fill("2.5");
  await page.getByLabel("Unit").selectOption({ label: "Loads (whole numbers)" });
  await expect(page.getByText("Quantities in load must be whole numbers.")).toBeVisible();
  await expect(page.getByText("No conversion is made")).toBeVisible();
  await page.getByLabel("Delivered quantity").fill("21.47");
  await page.getByLabel("Unit").selectOption({ label: "Tons" });
  await page.getByLabel("Delivery time").fill("08:30");
  await page.getByLabel("Paper / scale ticket #").fill(f.paper);
  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expectToast(page, /Ticket TKT-\d{4,} submitted\./);
  await expect(page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);
  const number = (await page.getByRole("heading", { level: 1 }).textContent())!.replace("Ticket ", "").trim();
  await expect(page.getByText("21.47 tons")).toBeVisible();
  await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();
  // Dispatchers enter and correct tickets but do not accept or void them.
  await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);

  await page.getByRole("link", { name: "Correct" }).click();
  await expect(page.getByLabel("Delivered quantity")).toHaveValue("21.47");
  await page.getByLabel("Delivered quantity").fill("21.74");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByText("Enter the reason for the correction.").first()).toBeVisible();
  await page.getByLabel("Reason for the correction").fill("Digits swapped (e2e)");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expectToast(page, "Correction saved as revision 2.");
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  const history = page.getByRole("list", { name: "Ticket history" });
  await expect(history.getByText("Corrected → revision 2")).toBeVisible();
  await expect(history.getByText("Digits swapped (e2e)")).toBeVisible();
  await expect(page.getByRole("link", { name: "1", exact: true })).toBeVisible(); // revision 1 kept

  // The dispatch board shows the ticket on the load.
  await page.goto(`/dispatch?date=${f.yesterday}`);
  await expect(page.getByRole("link", { name: new RegExp(`${number}.*21\\.74 ton`) })).toBeVisible();

  // Office accepts it.
  await page.context().clearCookies();
  await signIn(page, "office");
  await page.goto(`/tickets?view=submitted&q=${number}`);
  await page.getByRole("link", { name: number }).click();
  const ticketUrl = page.url().split("?")[0];
  // Opened from the list, the ticket is in the review queue: accepting moves on (next ticket or back to the list).
  await page.getByRole("button", { name: /^Accept/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Accept" }).click();
  await expectToast(page, "Ticket accepted.");
  await page.waitForURL((u) => u.toString().split("?")[0] !== ticketUrl);
  await page.goto(ticketUrl);
  await expect(page.getByText("Accepted", { exact: true }).first()).toBeVisible();

  // A second ticket for the same load needs an explicit confirmation and is flagged.
  await page.goto(`/tickets/new?load=${f.loadId}`);
  await expect(page.getByText("This load already has a ticket")).toBeVisible();
  await page.getByLabel("Order line").selectOption({ label: "Gravel #53 limestone — ordered 44 tons" });
  await page.getByLabel("Delivered quantity").fill("3");
  await page.getByLabel("Unit").selectOption({ label: "Tons" });
  await page.getByLabel("Delivery time").fill("09:15");
  await page.getByLabel("Paper / scale ticket #").fill(`${f.paper}-B`);
  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expect(page.getByRole("alert").filter({ hasText: `already has ticket ${number}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit ticket" })).toBeDisabled();
  await page.getByLabel(/Yes, this is a separate delivery/).check();
  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expectToast(page, /submitted\./);
  await expect(page.getByText("Needs review", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Another ticket already exists for this load.")).toBeVisible();

  // Void it with a reason; it stays on record.
  await page.getByRole("button", { name: "Void" }).click();
  await page.getByRole("dialog").getByLabel("Reason").fill("Entered twice (e2e)");
  await page.getByRole("dialog").getByRole("button", { name: "Void ticket" }).click();
  await expectToast(page, "Ticket voided.");
  await expect(page.getByText("Entered twice (e2e)").first()).toBeVisible();

  // The order page lists the accepted ticket on its load.
  await page.goto(`/orders/${f.orderId}`);
  await expect(page.getByRole("list", { name: "Loads" }).getByRole("link", { name: new RegExp(number) })).toBeVisible();
  await expect(page.getByRole("list", { name: "Order history" }).getByText(new RegExp(`Ticket ${number} accepted`))).toBeVisible();
});

test("people without ticket permission cannot open delivery tickets", async ({ page }) => {
  await signIn(page, "mechanic");
  await page.goto("/tickets");
  await expect(page).toHaveURL(/no-access/);
});
