import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

// Driver payroll (docs/PAYROLL.md): the owner writes a rule, previews it, activates it, calculates a period from a
// verified ticket, approves it and downloads the export. Other roles cannot open payroll. Isolated: a fresh driver and a
// random day 4–12 months ago, so no other test's tickets fall into this period.

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

async function acceptedTicket() {
  const id = unique();
  // Its own (non-sample) material, created by the owner: sample materials used by a real order stay behind after
  // Remove sample data.
  const material = await asUser(USERS.owner.email, async (q: Q) =>
    (await q("insert into public.materials (name, default_unit_code) values ($1, 'ton') returning id", [`Payroll Gravel ${id}`])).rows[0].id as string);
  const daysAgo = 120 + Math.floor(Math.random() * 240); // orders must be within a year
  return asUser(USERS.office.email, async (q: Q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      return (await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row))).rows[0].id as string;
    };
    const day = (await q("select (current_date - $1::int)::text as d", [daysAgo])).rows[0].d as string;
    const verified = new Date().toISOString();
    const driver = await ins("drivers", { name: `Payroll Driver ${id}` });
    await ins("driver_qualifications", { driver_id: driver, kind: "cdl", cdl_class: "A", expires_on: "2099-01-01", verified_at: verified });
    await ins("driver_qualifications", { driver_id: driver, kind: "medical_card", expires_on: "2099-01-01", verified_at: verified });
    const truck = await ins("trucks", { unit_number: `PAY-${id}`, truck_type: "tri_axle_dump" });
    // Its own (non-sample) customer: a sample customer's tickets would block Remove sample data once paid.
    const cust = { rows: [{ id: await ins("customers", { name: `Payroll Customer ${id}` }) }] };
    const o = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "1 Payroll Pit Rd (test)", customer_id: cust.rows[0].id, order_date: day, project_name: `Payroll e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: material, description: "Gravel (test)", unit_code: "ton", quantity: "22", unit_rate_cents: 1000 }],
    })])).rows[0].r as { order_id: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: day, scheduled_end: day })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    const load = ((await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: day, start_time: "07:00", end_time: "09:00", planned_quantity: "22", unit_code: "ton" })])).rows[0].r as { load_id: string }).load_id;
    await q("select public.assign_load($1, $2, null, $3, '', null)", [load, truck, driver]);
    const line = (await q("select id from public.order_lines where order_id = $1 order by line_no limit 1", [o.order_id])).rows[0].id as string;
    const t = (await q("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify({ load_id: load, order_line_id: line, delivered_date: day, delivered_time: "08:30", quantity: "21.47", unit_code: "ton", external_reference: `SC-${id}`, notes: "" })])).rows[0].r as { ticket_id: string; ticket_number: string };
    await q("select public.review_delivery_ticket($1, 'accept', 'Matches scale ticket (test)')", [t.ticket_id]);
    return { day, driver: `Payroll Driver ${id}`, ticket: t.ticket_number };
  });
}

test("the owner sets a rule, calculates a period from a verified ticket, approves it and exports it", async ({ page }) => {
  test.slow();
  const f = await acceptedTicket();
  await signIn(page, "owner");

  // A draft scoped to this driver, previewed on recent tickets, then approved.
  await page.goto("/payroll/rules");
  await page.getByLabel("Name (for a new rule)").fill(`Per ton ${f.driver}`);
  await page.getByLabel("Formula").fill("tons * rate");
  await page.getByLabel("Rate").fill("4.25");
  await page.getByLabel("Tickets in").selectOption({ label: "Tons" });
  await page.getByLabel("Only for driver").selectOption({ label: f.driver });
  await page.getByLabel("First day").fill(f.day);
  await page.getByLabel("Where this rule comes from").fill("Fictional test rule");
  await page.getByRole("button", { name: "Save draft" }).click();
  const rule = page.locator("section").filter({ hasText: `Per ton ${f.driver}` });
  await expect(rule.getByText("Draft — not used")).toBeVisible();
  // Bad formulas are refused with a reason before anything is saved.
  await page.getByLabel("Formula").fill("tons * price");
  await page.getByLabel("First day").fill(f.day);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(/"price" is not a supported input/)).toBeVisible();
  await rule.getByRole("button", { name: "Approve and activate" }).click();
  await expect(page.getByText(/Tick the box to confirm/)).toBeVisible();
  await rule.getByLabel("This matches our agreed pay terms, checked against past payroll").check();
  await rule.getByRole("button", { name: "Approve and activate" }).click();
  await expect(rule.getByText("Active", { exact: true })).toBeVisible();

  // Calculation on, a one-day period, calculate.
  await page.goto("/payroll");
  await page.getByLabel("Calculate earnings from verified tickets").check();
  await page.getByRole("button", { name: "Save settings" }).click();
  // The box was already ticked before saving: wait for the save itself before filling the period form.
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Calculate earnings from verified tickets")).toBeChecked();
  await page.getByLabel("First day").fill(f.day);
  await page.getByLabel("Last day").fill(f.day);
  await page.getByRole("button", { name: "Create period" }).click();
  await expect(page).toHaveURL(/\/payroll\/periods\/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: /^Calculate 1 ticket$/ }).click();
  const tickets = page.locator("section").filter({ has: page.getByRole("heading", { name: "Tickets in this period" }) });
  await expect(tickets.getByRole("row").filter({ hasText: f.ticket })).toContainText("(tons (21.47) * rate (4.25)) = 91.2475 → 91.25");
  await expect(page.locator("section").filter({ has: page.getByRole("heading", { name: "Earnings by driver" }) }).getByRole("row").filter({ hasText: f.driver })).toContainText("$91.25");

  // Approve and lock, then export once.
  await page.getByLabel(/I checked the totals/).check();
  await page.getByRole("button", { name: "Approve and lock" }).click();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download summary (CSV)" }).click();
  const file = await (await download).path();
  const csv = (await import("node:fs")).readFileSync(file!, "utf8");
  expect(csv.split("\n")[1]).toContain(`${f.driver},,Delivery ticket earnings,1,91.25,0.00,91.25`);
  await page.reload();
  await expect(page.getByText(/Summary · 1 rows · \$91\.25/)).toBeVisible();
});

test("payroll is the owner's: office and dispatch cannot open it", async ({ page }) => {
  for (const who of ["office", "dispatcher"] as const) {
    await signIn(page, who);
    await page.goto("/payroll");
    await expect(page, who).toHaveURL(/\/no-access/);
    await page.context().clearCookies();
  }
});
