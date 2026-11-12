import { expect, test, type Locator } from "@playwright/test";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

// RL1 (owner decision 2026-11-12, "Block it"): once a load has a delivery ticket, dispatch can no longer reassign it.
// The dispatcher sees why and the next step on the load itself, and a reassignment started before the ticket arrived is
// refused with the database's own words in the window. Voiding the ticket brings Reassign back. Synthetic fixtures on
// yesterday's board; cleaned up.

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;
const plusDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function choose(select: Locator, prefix: string) {
  const value = await select.locator("option", { hasText: prefix }).first().getAttribute("value");
  await select.selectOption(value!);
}

/** Yesterday's in-progress order with two loads on truck A; a second truck and driver are free. */
async function fixture() {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const today = (await q("select (now() at time zone (select timezone from public.company_settings limit 1))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const verified = new Date().toISOString();
    const crew = async (n: string) => {
      const truck = await ins("trucks", { unit_number: `RL${n}-${id}`, truck_type: "tri_axle_dump" });
      const driver = await ins("drivers", { name: `Rowan Ticket${n} ${id}` });
      await ins("driver_qualifications", { driver_id: driver, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
      await ins("driver_qualifications", { driver_id: driver, kind: "medical_card", expires_on: plusDays(600), verified_at: verified });
      return { truck, driver, unit: `RL${n}-${id}`, name: `Rowan Ticket${n} ${id}` };
    };
    const a = await crew("A");
    const b = await crew("B");
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "12 Weighbridge Lane (test)", customer_id: cust.rows[0].id, order_date: yesterday, project_name: `Ticketed load e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
    })]);
    const order = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [order.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [order.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [order.order_id]);
    await q("select public.set_order_status($1, 'in_progress', '')", [order.order_id]);
    const line = (await q("select id from public.order_lines where order_id = $1", [order.order_id])).rows[0].id as string;
    const loads: string[] = [];
    for (const [start, end] of [["06:00", "07:00"], ["08:00", "09:00"]]) {
      const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: order.order_id, load_date: yesterday, start_time: start, end_time: end, planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
      await q("select public.assign_load($1, $2, null, $3, '', null)", [load, a.truck, a.driver]);
      loads.push(load);
    }
    /** The driver's ticket for load 1, entered by the office (in its own transaction, later). */
    const ticket = () => office(async (q2) => (await q2("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
      load_id: loads[0], order_line_id: line, delivered_date: yesterday, delivered_time: "06:40", quantity: "21.8", unit_code: "ton", external_reference: `RL-${id}`,
    })])).rows[0].r as { ticket_id: string; ticket_number: string });
    return { yesterday, orderId: order.order_id, orderNumber: order.order_number, loads, a, b, ticket };
  });
}

async function cleanup(orderId: string) {
  await office(async (q) => {
    for (const t of (await q("select id from public.delivery_tickets where order_id = $1 and status in ('submitted', 'needs_review', 'accepted')", [orderId])).rows) {
      await q("select public.review_delivery_ticket($1, 'void', 'e2e cleanup')", [t.id]);
    }
    await q("select public.set_order_status($1, 'on_hold', 'e2e cleanup')", [orderId]);
    await q("select public.set_order_status($1, 'canceled', 'e2e cleanup')", [orderId]);
  });
}

test("a ticketed load cannot be reassigned: the dispatcher sees why and what to do, and Reassign returns once the ticket is voided", async ({ page }) => {
  test.slow();
  const f = await fixture();
  try {
    await signIn(page, "dispatcher");
    await page.goto(`/dispatch?date=${f.yesterday}`);
    const card = page.locator("section").filter({ has: page.getByRole("link", { name: f.orderNumber, exact: true }) });
    const load1 = card.getByRole("listitem", { name: "Load 1", exact: true });
    const load2 = card.getByRole("listitem", { name: "Load 2", exact: true });

    // Reassignment started before the ticket arrives: the board still offers it.
    await load1.getByRole("button", { name: "Reassign" }).click();
    const dialog = page.getByRole("dialog");
    await choose(dialog.getByLabel("Truck"), f.b.unit);
    await choose(dialog.getByLabel("Driver"), f.b.name);

    // The driver's ticket for load 1 comes in meanwhile.
    const t = await f.ticket();

    // The database refuses, and the window shows its reason and next step, not a generic error.
    await dialog.getByRole("button", { name: "Reassign", exact: true }).click();
    await expect(dialog.getByText(
      `${f.orderNumber} load 1 already has delivery ticket ${t.ticket_number}, so its truck and driver can no longer be changed. ` +
      "If they are wrong, correct the ticket in Tickets, or void it there and then reassign the load.",
    )).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // On the board: no Reassign or Remove on the ticketed load, the reason and the next step instead; load 2 unchanged.
    await page.reload();
    await expect(load1.getByText("Can't reassign", { exact: true })).toBeVisible();
    await expect(load1.getByText(/A delivery ticket is entered for this load\. Wrong truck or driver\?/)).toBeVisible();
    await expect(load1.getByRole("button", { name: "Reassign" })).toHaveCount(0);
    await expect(load1.getByRole("button", { name: /Remove assignment/ })).toHaveCount(0);
    await expect(load1.getByRole("link", { name: "Correct the ticket in Tickets first" })).toHaveAttribute("href", `/tickets/${t.ticket_id}`);
    await expect(load1.getByText(f.a.unit)).toBeVisible();
    await expect(load2.getByRole("button", { name: "Reassign" })).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await load1.screenshot({ path: process.env.RL1_SCREENSHOT ?? test.info().outputPath("ticketed-load.png") });

    // The office voids the ticket: Reassign is back.
    await office(async (q) => q("select public.review_delivery_ticket($1, 'void', 'Entered on the wrong truck (test)')", [t.ticket_id]));
    await page.reload();
    await expect(load1.getByRole("button", { name: "Reassign" })).toBeVisible();
    await expect(load1.getByText("Can't reassign", { exact: true })).toHaveCount(0);
  } finally {
    await cleanup(f.orderId);
  }
});
