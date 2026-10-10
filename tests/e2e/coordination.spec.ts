import { expect, test } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Workflow coordination across modules: urgent orders from the office to
// dispatch, the ticket review queue, the order's progress panel, the personal
// Command Center layout and hiding, an owner who also drives, and the other
// company seeing none of it. Fixtures are synthetic and created through the
// app's own database functions; flagged orders are canceled at the end.

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;

async function admin<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const plusDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** A scheduled Top Line order (today .. tomorrow) with a ready truck and driver, and `tickets` submitted tickets on yesterday's loads. */
async function fixture(tickets = 0) {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const today = (await q("select private_today from (select (now() at time zone (select timezone from public.company_settings limit 1))::date::text as private_today) x")).rows[0].private_today as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const truckId = await ins("trucks", { unit_number: `CO-${id}`, truck_type: "tri_axle_dump" });
    const driverId = await ins("drivers", { name: `Corey Coordination ${id}` });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driverId, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
    await ins("driver_qualifications", { driver_id: driverId, kind: "medical_card", expires_on: plusDays(600), verified_at: verified });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: cust.rows[0].id, order_date: yesterday, project_name: `Coordination e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
    })]);
    const order = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [order.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [order.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: plusDays(1) })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [order.order_id]);
    const line = (await q("select id from public.order_lines where order_id = $1", [order.order_id])).rows[0].id as string;
    const ticketIds: string[] = [];
    for (let i = 0; i < tickets; i++) {
      const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: order.order_id, load_date: yesterday, start_time: `0${6 + i}:00`, end_time: `0${6 + i}:30` })])).rows[0].r as { load_id: string }).load_id;
      await q("select public.assign_load($1, $2, null, $3, '', null)", [load, truckId, driverId]);
      const t = (await q("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({ load_id: load, order_line_id: line, delivered_date: yesterday, delivered_time: `0${6 + i}:20`, quantity: "22", unit_code: "ton", external_reference: `CO-${id}-${i}` })])).rows[0].r as { ticket_id: string };
      ticketIds.push(t.ticket_id);
    }
    return { orderId: order.order_id, orderNumber: order.order_number, truckId, driverId, today, yesterday, ticketIds };
  });
}

/** Cleanup the way a user would: void the order's live tickets, then cancel it (which also closes an urgent flag). */
const cancel = (orderId: string) => office(async (q) => {
  for (const t of (await q("select id from public.delivery_tickets where order_id = $1 and status in ('submitted', 'needs_review', 'accepted')", [orderId])).rows) {
    await q("select public.review_delivery_ticket($1, 'void', 'e2e cleanup')", [t.id]);
  }
  await q("select public.set_order_status($1, 'canceled', 'e2e cleanup')", [orderId]);
});

test("the office flags an urgent order, dispatch acknowledges it on the board, and the other company sees nothing", async ({ page, browser }) => {
  const f = await fixture();
  try {
    await signIn(page, "office");
    await page.goto(`/orders/${f.orderId}`);
    const progress = page.getByRole("list", { name: "Order progress" });
    await expect(progress.getByRole("listitem", { name: /Dispatch: Not started|Dispatch: Needs action/ })).toBeVisible();
    await page.getByRole("button", { name: "Flag as urgent" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("Why is it urgent?").fill("Customer moved the pour up to 7 AM (e2e)");
    await d.getByLabel("Needed by (date)").fill(plusDays(1));
    await d.getByLabel("Time").fill("07:00");
    await d.getByRole("button", { name: "Flag as urgent" }).click();
    await expectToast(page, "Flagged urgent.");
    await expect(page.getByText("Awaiting acknowledgement").first()).toBeVisible();
    await expect(page.getByText("Dispatch: acknowledge it")).toBeVisible();

    // Dispatch sees it before planning the day, and acknowledges it there.
    const dctx = await browser.newContext();
    const dp = await dctx.newPage();
    await signIn(dp, "dispatcher");
    await dp.goto("/dispatch");
    const banner = dp.getByRole("region", { name: "Urgent orders" });
    const row = banner.getByRole("listitem").filter({ hasText: f.orderNumber });
    await expect(row).toContainText("Customer moved the pour up to 7 AM (e2e)");
    await row.getByRole("button", { name: "Acknowledge" }).click();
    await expect(row).toContainText("Acknowledged by dispatch");
    // In the Command Center it is now "being worked on", with who acknowledged it.
    await dp.goto("/command-center?kind=urgent_order");
    const item = dp.getByRole("listitem", { name: `${f.orderNumber} is urgent — acknowledged by dispatch` });
    await expect(item).toContainText(`acknowledged by ${USERS.dispatcher.name}`);
    await expect(item).toContainText("No truck assigned yet.");
    await dctx.close();

    // The order's history shows each step; nothing was assigned automatically.
    await page.reload();
    await page.getByText(/Urgency history/).click();
    await expect(page.getByRole("list", { name: "Urgency history" })).toContainText("Acknowledged by dispatch");
    await expect(page.getByText(/No loads (planned )?yet/).first()).toBeVisible();

    // Another company: no urgent order, and the order URL does not exist for it.
    const octx = await browser.newContext();
    const op = await octx.newPage();
    await signIn(op, "otherOwner");
    await op.goto("/command-center?kind=urgent_order");
    await expect(op.getByRole("listitem", { name: new RegExp(f.orderNumber) })).toHaveCount(0);
    await op.goto(`/orders/${f.orderId}`);
    await expect(op.getByText("Not found", { exact: true })).toBeVisible();
    await op.goto("/dispatch");
    await expect(op.getByRole("region", { name: "Urgent orders" })).toHaveCount(0);
    await octx.close();
  } finally {
    await cancel(f.orderId);
  }
});

test("reviewing tickets in sequence: queue position, accept and next, and back to the same queue", async ({ page }) => {
  const f = await fixture(2);
  try {
    await signIn(page, "office");
    await page.goto("/tickets?view=submitted");
    const first = (await admin((c) => c.query("select ticket_number from public.delivery_tickets where id = $1", [f.ticketIds[0]]))).rows[0].ticket_number as string;
    await page.getByRole("link", { name: first, exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Review queue" })).toContainText(/Review queue: \d+ of \d+/);
    await page.getByRole("button", { name: "Accept and next" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Accept" }).click();
    await expectToast(page, /Opening the next ticket/);
    await expect(page).not.toHaveURL(new RegExp(f.ticketIds[0]));
    await expect(page.getByRole("navigation", { name: "Review queue" })).toBeVisible();
    // The accepted ticket left the queue; its order shows the step done.
    expect((await admin((c) => c.query("select status from public.delivery_tickets where id = $1", [f.ticketIds[0]]))).rows[0].status).toBe("accepted");
    await page.getByRole("link", { name: "Back to the ticket queue" }).click();
    await expect(page).toHaveURL(/\/tickets\?view=submitted$/);
  } finally {
    await cancel(f.orderId);
  }
});

test("the Command Center is arranged per person, hides only from your view, and an owner who drives sees their own loads", async ({ page }) => {
  const f = await fixture();
  const ownerId = (await admin((c) => c.query("select id from public.profiles where email = $1", [USERS.owner.email]))).rows[0].id as string;
  try {
    // Link the owner to a driver record and give them a load today (as the office would).
    await admin((c) => c.query("update public.drivers set user_id = $2 where id = $1", [f.driverId, ownerId]));
    await office(async (q) => {
      const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: f.orderId, load_date: f.today, start_time: "23:00", end_time: "23:45" })])).rows[0].r as { load_id: string }).load_id;
      await q("select public.assign_load($1, $2, null, $3, '', null)", [load, f.truckId, f.driverId]);
      await q("select public.flag_order_urgent($1, 'Hide test (e2e)', null)", [f.orderId]);
    });

    await signIn(page, "owner");
    await expect(page).toHaveURL(/\/command-center/);
    const yourLoads = page.getByRole("list", { name: "Your loads today" });
    await expect(yourLoads).toContainText(`${f.orderNumber} load`);
    // Company-wide priorities are on the same page; being a driver adds no permission (the database decides).
    await expect(page.getByRole("region", { name: "Attention summary" })).toBeVisible();

    // An urgent item cannot be hidden; once acknowledged it can — only from this person's view.
    await page.goto("/command-center?kind=urgent_order");
    const item = page.getByRole("listitem", { name: new RegExp(`${f.orderNumber} is urgent`) });
    await expect(item.getByRole("button", { name: "Hide for me" })).toHaveCount(0);
    await office(async (q) => {
      const u = (await q("select id from public.order_urgencies where order_id = $1 and closed_at is null", [f.orderId])).rows[0].id;
      await q("select public.update_order_urgency($1, 'acknowledged', '')", [u]);
    });
    await page.reload();
    await item.getByRole("button", { name: "Hide for me" }).click();
    await page.getByRole("group", { name: "Hide for how long" }).getByRole("button", { name: "For 4 hours" }).click();
    await expectToast(page, "Hidden from your view");
    await expect(item).toHaveCount(0);
    await page.getByRole("link", { name: /Hidden by you/ }).first().click();
    await expect(item).toContainText("still open");
    await item.getByRole("button", { name: "Show again" }).click();
    await expectToast(page, "Shown again.");

    // Collapse a section and move the queue to the top; it stays that way after reload. The pinned summary stays.
    await page.goto("/command-center");
    await page.getByRole("button", { name: "Sales and quotes" }).click();
    await page.getByRole("button", { name: "Arrange sections" }).click();
    await page.getByRole("button", { name: "Move Attention queue up" }).click();
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.getByRole("button", { name: "Sales and quotes" })).toHaveAttribute("aria-expanded", "false");
    const headings = await page.locator("main h2[id^=section-]").allTextContents();
    expect(headings[0]).toBe("Attention queue");
    await expect(page.getByRole("region", { name: "Attention summary" })).toBeVisible();
  } finally {
    await admin((c) => c.query("update public.drivers set user_id = null where id = $1", [f.driverId]));
    await admin((c) => c.query("delete from public.user_preferences where user_id = $1", [ownerId]));
    await admin((c) => c.query("delete from public.exception_dismissals where user_id = $1", [ownerId]));
    await cancel(f.orderId);
  }
});
