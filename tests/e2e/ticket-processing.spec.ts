import { expect, test } from "@playwright/test";
import pg from "pg";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Delivery ticket processing end to end in the browser: a paper ticket received
// without its number, explained review reasons, delivery context, an office scan
// of the paper, a correction and verification, delivered-so-far on the order,
// billing readiness following, bulk acceptance of clean tickets, the completion
// warning — and another company seeing none of it. Synthetic fixtures; cleaned up.

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const office = <T,>(fn: (q: Q) => Promise<T>) => asUser(USERS.office.email, fn as never) as Promise<T>;
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const plusDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** A scheduled order (44 t) with three assigned loads yesterday; `tickets` of them get a submitted ticket. */
async function fixture(opts: { withRef: boolean[] }) {
  const id = unique();
  return office(async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const today = (await q("select (now() at time zone (select timezone from public.company_settings limit 1))::date::text as d")).rows[0].d as string;
    const yesterday = (await q("select ($1::date - 1)::text as d", [today])).rows[0].d as string;
    const truckId = await ins("trucks", { unit_number: `TP-${id}`, truck_type: "tri_axle_dump" });
    const driverId = await ins("drivers", { name: `Terry Ticket ${id}` });
    const verified = new Date().toISOString();
    await ins("driver_qualifications", { driver_id: driverId, kind: "cdl", cdl_class: "A", expires_on: plusDays(600), verified_at: verified });
    await ins("driver_qualifications", { driver_id: driverId, kind: "medical_card", expires_on: plusDays(600), verified_at: verified });
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: yesterday, project_name: `Ticket processing e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "44", unit_rate_cents: 1000 }],
    })]);
    const order = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [order.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [order.order_id, JSON.stringify({ scheduled_start: yesterday, scheduled_end: today })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [order.order_id]);
    await q("select public.set_order_status($1, 'in_progress', '')", [order.order_id]);
    const line = (await q("select id from public.order_lines where order_id = $1", [order.order_id])).rows[0].id as string;
    const tickets: Array<{ id: string; number: string }> = [];
    const loads: string[] = [];
    for (let i = 0; i < 3; i++) {
      const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: order.order_id, load_date: yesterday, start_time: `0${6 + i}:00`, end_time: `0${6 + i}:40`, planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
      await q("select public.assign_load($1, $2, null, $3, '', null)", [load, truckId, driverId]);
      loads.push(load);
      if (i < opts.withRef.length) {
        const t = (await q("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({
          load_id: load, order_line_id: line, delivered_date: yesterday, delivered_time: `0${6 + i}:30`, quantity: "22", unit_code: "ton",
          external_reference: opts.withRef[i] ? `TP-${id}-${i}` : "",
        })])).rows[0].r as { ticket_id: string; ticket_number: string };
        tickets.push({ id: t.ticket_id, number: t.ticket_number });
      }
    }
    return { orderId: order.order_id, orderNumber: order.order_number, tickets, loads, id };
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

test("a paper ticket is received, explained, scanned, corrected and verified; the order and billing follow; other companies see nothing", async ({ page, browser }) => {
  const f = await fixture({ withRef: [false] });
  const t = f.tickets[0];
  try {
    await signIn(page, "office");
    await page.goto(`/tickets/${t.id}`);
    // Received is not verified, and the reason explains itself.
    const reasons = page.getByRole("list", { name: "Review reasons" });
    await expect(reasons).toContainText("No paper / scale ticket number was entered.");
    await expect(reasons).toContainText("Why it matters:");
    await expect(reasons).toContainText("Handled by: Office reviewer");
    // Delivery context without leaving the page.
    const progress = page.getByRole("list", { name: "Order line progress" }).or(page.locator("dl[aria-label='Order line progress']"));
    await expect(progress).toContainText("44 tons");
    await expect(progress).toContainText("22"); // this ticket, and 22 remaining after it
    await expect(page.getByText("matches this ticket")).toBeVisible();

    // The office adds a scan of the paper ticket; the history records it.
    await page.getByLabel("Choose a scan or photo of the paper ticket").setInputFiles({ name: "ticket.png", mimeType: "image/png", buffer: PNG_1PX });
    await expectToast(page, "Scan added to the ticket.");
    await expect(page.getByRole("heading", { name: "Paper ticket photos (1)" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Ticket history" })).toContainText("Scan or photo added");

    // Correct it with the number from the paper; the scan stays; verify it.
    await page.getByRole("link", { name: "Correct" }).click();
    await page.getByLabel(/Paper.*ticket #/i).fill(`TP-${f.id}-paper`);
    await page.getByLabel(/Reason for the correction/i).fill("Number read from the scan (e2e)");
    await page.getByRole("button", { name: /Save correction/i }).click();
    await expect(page.getByText(/Revision 2/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Paper ticket photos (1)" })).toBeVisible();
    await page.getByRole("button", { name: /^Accept/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Accept" }).click();
    await expectToast(page, "Ticket accepted.");

    // The order shows what is delivered and verified, and what remains; billing waits for the other loads.
    await page.goto(`/orders/${f.orderId}`);
    const delivered = page.getByRole("table", { name: "Delivered so far" });
    await expect(delivered).toContainText("44 ton");
    await expect(delivered.getByRole("row").nth(1)).toContainText("22");
    await expect(page.getByRole("list", { name: "Order progress" })).toContainText("Billing readiness");
    // Completing warns about the delivered loads that still have no ticket.
    await page.getByRole("button", { name: /Mark completed|Complete/ }).first().click();
    await expect(page.getByRole("dialog").getByRole("note")).toContainText("2 delivered load(s) have no delivery ticket");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

    // Another company: no ticket by URL, no upload into it.
    const octx = await browser.newContext();
    const op = await octx.newPage();
    await signIn(op, "otherOwner");
    await op.goto(`/tickets/${t.id}`);
    await expect(op.getByText("Not found", { exact: true })).toBeVisible();
    const res = await op.request.post(`/tickets/${t.id}/scans`, {
      headers: { origin: new URL(op.url()).origin },
      multipart: { file: { name: "x.png", mimeType: "image/png", buffer: PNG_1PX }, upload_key: crypto.randomUUID() },
    });
    expect([403, 404]).toContain(res.status());
    await octx.close();
  } finally {
    await cleanup(f.orderId);
  }
});

test("clean received tickets are accepted together after confirmation; flagged ones stay for individual review", async ({ page }) => {
  const f = await fixture({ withRef: [true, true, false] });
  try {
    await signIn(page, "office");
    await page.goto(`/tickets?view=submitted`);
    await page.getByRole("button", { name: /Accept clean tickets/ }).click();
    const d = page.getByRole("dialog");
    const list = d.getByRole("group", { name: "Tickets to accept" });
    for (const t of f.tickets.slice(0, 2)) await expect(list).toContainText(t.number);
    await expect(list).not.toContainText(f.tickets[2].number); // flagged: missing paper number
    // Accept only this test's tickets.
    for (const box of await list.getByRole("checkbox").all()) {
      const label = await box.locator("xpath=..").innerText();
      if (!f.tickets.slice(0, 2).some((t) => label.includes(t.number))) await box.uncheck();
    }
    await d.getByRole("button", { name: /Accept 2 tickets/ }).click();
    await expectToast(page, "2 tickets accepted.");
    const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await db.connect();
    const st = (await db.query("select ticket_number, status from public.delivery_tickets where id = any($1) order by ticket_number", [f.tickets.map((t) => t.id)])).rows;
    await db.end();
    expect(st.filter((r) => r.status === "accepted")).toHaveLength(2);
    expect(st.find((r) => r.ticket_number === f.tickets[2].number)?.status).not.toBe("accepted");

    // Filters: by review reason.
    await page.goto(`/tickets?view=review&reason=missing_external_reference`);
    await expect(page.getByRole("link", { name: f.tickets[2].number, exact: true })).toBeVisible();
  } finally {
    await cleanup(f.orderId);
  }
});
