// Hauler settlements (B129), end to end: a delivered hired job with an accepted ticket (set up through the app's own
// functions), a 10 % commission set on the page, a draft settlement for the day, a fuel-advance deduction, approval and
// a recorded payment. Taviron moves no money. Fictional records only.
import pg from "pg";
import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

const TOP_LINE = "00000000-0000-4000-8000-000000000001";

async function admin<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

test.afterAll(async () => {
  await admin((c) => c.query("delete from private.hired_trucks_entitlements where company_id = $1", [TOP_LINE]));
});

test("payroll settles a hauler's delivered job: commission, a deduction, approval and a recorded payment", async ({ page }) => {
  test.slow();
  const id = unique();
  const haulerName = `Settle Hauling ${id}`;
  await admin((c) => c.query("insert into private.hired_trucks_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [TOP_LINE]));
  const day = await asUser(USERS.owner.email, async (q) => {
    const today = "(now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date";
    const d = (await q(`select (${today} - 2)::text as d`)).rows[0].d as string;
    const far = (await q(`select (${today} + 300)::text as d`)).rows[0].d as string;
    const h = (await q("select public.hauler_save(null, $1, 'Pat', '555-0100', '', '', true) as r", [haulerName])).rows[0].r as string;
    const truck = (await q("select public.hauler_add_truck($1, $2, 'tri_axle_dump', '') as r", [h, `ST-${id}`.slice(0, 20)])).rows[0].r as string;
    const driver = (await q("select public.hauler_add_driver($1, $2, '') as r", [h, `Settle Driver ${id}`])).rows[0].r as string;
    for (const [kind, truckId, exp] of [["insurance", null, far], ["w9", null, null], ["agreement", null, null], ["registration", truck, far], ["inspection", truck, far]] as const) {
      await q("select public.hauler_record_document($1, $2, $3, 'ref', $4)", [h, truckId, kind, exp]);
    }
    for (const kind of ["cdl", "medical_card"]) await q("insert into public.driver_qualifications (driver_id, kind, cdl_class, expires_on, verified_at) values ($1, $2, $3, $4, now())", [driver, kind, kind === "cdl" ? "A" : null, far]);
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
    const mat = await q("select id from public.materials where code = 'GRV-53' and company_id = $1", [TOP_LINE]);
    const o = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, order_date: d, project_name: `Settle e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mat.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "20", unit_rate_cents: 1000 }],
    })])).rows[0].r as { order_id: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: d, scheduled_end: d })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const load = (await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: d, start_time: "05:00", end_time: "05:45", planned_quantity: "20", unit_code: "ton" })])).rows[0].r.load_id as string;
    const offer = (await q("select public.hauler_offer_send($1, $2, null, $3, 1500, 'ton', '') as r", [load, truck, driver])).rows[0].r as string;
    await q("select public.hauler_offer_respond($1, true, 'By phone (test)')", [offer]);
    await q("select public.hauler_offer_confirm($1)", [offer]);
    const line = (await q("select id from public.order_lines where order_id = $1 limit 1", [o.order_id])).rows[0].id;
    const t = (await q("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({ load_id: load, order_line_id: line, delivered_date: d, delivered_time: "05:45", quantity: "20", unit_code: "ton", external_reference: `ST-${id}` })])).rows[0].r.ticket_id;
    await q("select public.review_delivery_ticket($1, 'accept', '')", [t]);
    return d;
  });

  await signIn(page, "owner");
  await page.goto("/hired-trucks");
  const commission = page.getByRole("form", { name: `Commission for ${haulerName}` });
  await commission.getByRole("textbox").fill("10");
  await commission.getByRole("button", { name: "Save" }).click();
  await expectToast(page, /Commission saved/);

  const form = page.getByRole("form", { name: "New settlement" });
  await form.getByLabel("Hauler").selectOption({ label: haulerName });
  await form.locator("#st-from").fill(day);
  await form.locator("#st-to").fill(day);
  await form.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/hired-trucks\/settlements\//);
  const totals = page.getByRole("article", { name: "Settlement statement" }).getByLabel("Totals");
  await expect(totals).toContainText("$300.00"); // 20 tons × $15.00
  await expect(totals).toContainText("Commission (10%)");
  await expect(totals).toContainText("$270.00");

  const deduction = page.getByRole("form", { name: "Add a deduction" });
  await deduction.getByLabel("What for").fill("Fuel advance (test)");
  await deduction.getByLabel("Amount ($)").fill("50");
  await deduction.getByRole("button", { name: "Add deduction" }).click();
  await expectToast(page, "Deduction added.");
  await expect(totals).toContainText("$220.00");

  await page.getByRole("button", { name: "Approve" }).click();
  await expectToast(page, /Approved/);
  await expect(page.getByRole("form", { name: "Add a deduction" })).toHaveCount(0);
  const pay = page.getByRole("form", { name: "Record payment" });
  await pay.getByLabel("Reference").fill(`CHK ${id}`.slice(0, 20));
  await pay.getByRole("button", { name: "Mark paid" }).click();
  await expectToast(page, "Recorded as paid.");
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
});
