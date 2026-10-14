import { expect, test, type Page } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Smart Dispatch on the dispatch board (N15): proposals are only suggestions;
// approving assigns through the normal checks, rejecting moves to the next
// option, a proposal that went stale is refused, and people without
// dispatch.edit cannot approve. Fictional data only.

function plusDays(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Fixture {
  orderId: string;
  orderNumber: string;
  loadId: string;
  truckId: string;
  driverId: string;
}

/**
 * A scheduled order tomorrow with one open load at an unusual hour (so other
 * tests' loads do not compete for trucks), plus two trucks and two qualified
 * drivers of its own so at least one feasible pair exists.
 */
async function fixture(): Promise<Fixture> {
  const id = unique();
  const date = plusDays(1);
  const far = plusDays(600);
  return asUser(USERS.office.email, async (q) => {
    const ins = async (table: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const r = await q(`insert into public.${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row));
      return r.rows[0].id as string;
    };
    const verified = new Date().toISOString();
    const truckId = await ins("trucks", { unit_number: `SD1-${id}`, truck_type: "tri_axle_dump", weight_capacity: 22, weight_unit: "ton", capacity_verified_at: verified });
    await ins("trucks", { unit_number: `SD2-${id}`, truck_type: "tri_axle_dump", weight_capacity: 22, weight_unit: "ton", capacity_verified_at: verified });
    const drivers: string[] = [];
    for (const name of [`Sam Smart ${id}`, `Riley Smart ${id}`]) {
      const d = await ins("drivers", { name });
      await ins("driver_qualifications", { driver_id: d, kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified });
      await ins("driver_qualifications", { driver_id: d, kind: "medical_card", expires_on: far, verified_at: verified });
      drivers.push(d);
    }
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = '00000000-0000-4000-8000-000000000001'");
    const r = await q("select public.save_order_draft($1::jsonb) as r", [
      JSON.stringify({ customer_id: cust.rows[0].id, project_name: `Smart e2e ${id}`, site_line1: `${id} Proposal Rd`, site_city: "Crown Point", lines: [{ kind: "other", calc_method: "per_unit", description: "Stone (e2e)", unit_code: "ton", quantity: "18", unit_rate_cents: 1000 }] }),
    ]);
    const orderId = r.rows[0].r.order_id as string;
    await q("select public.set_order_status($1, 'confirmed', '')", [orderId]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [orderId, JSON.stringify({ scheduled_start: date })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [orderId]);
    const minute = 10 + (Date.now() % 40);
    const load = await q("select public.save_order_load($1::jsonb) as r", [
      JSON.stringify({ order_id: orderId, load_date: date, start_time: `03:${minute}`, end_time: `04:${minute}`, planned_quantity: "18", unit_code: "ton" }),
    ]);
    return { orderId, orderNumber: r.rows[0].r.order_number as string, loadId: load.rows[0].r.load_id as string, truckId, driverId: drivers[0] };
  });
}

const card = (page: Page, f: Fixture) => page.getByRole("listitem", { name: `${f.orderNumber} load 1` });

test("a dispatcher approves a proposal: it is assigned with an audit note, and nothing is assigned before approval", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "dispatcher");
  await page.goto("/dispatch?horizon=3");
  const c = card(page, f);
  await expect(c.getByText("Proposed:")).toBeVisible();
  // Showing a proposal assigns nothing.
  const before = await asUser(USERS.office.email, (q) => q("select count(*)::int as n from public.dispatch_assignments where load_id = $1", [f.loadId]));
  expect(before.rows[0].n).toBe(0);

  await c.getByRole("button", { name: "Approve and assign" }).click();
  await expectToast(page, new RegExp(`${f.orderNumber} load 1: assigned to truck`));
  await expect(c).toHaveCount(0);
  const after = await asUser(USERS.office.email, (q) => q("select note from public.dispatch_assignments where load_id = $1 and status = 'active'", [f.loadId]));
  expect(after.rows).toEqual([{ note: "Approved Smart Dispatch proposal" }]);
});

test("rejecting a proposal moves to the next option; reconsidering brings it back", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "dispatcher");
  await page.goto("/dispatch?horizon=3");
  const c = card(page, f);
  const first = (await c.locator("p", { hasText: "Proposed:" }).textContent())!;
  await c.getByRole("button", { name: "Reject…" }).click();
  await c.getByLabel("Reason for rejecting").fill("Driver prefers the north route (e2e)");
  await c.getByRole("button", { name: "Reject this option" }).click();
  // The board recomputes every proposal after a rejection; slow on the dev server with the test database's many trucks.
  await expect(c.getByText("1 option rejected.")).toBeVisible({ timeout: 20_000 });
  await expect(c.locator("p", { hasText: "Proposed:" })).not.toHaveText(first);
  await c.getByRole("button", { name: "Reconsider" }).click();
  await expect(c.getByText("1 option rejected.")).toHaveCount(0);
});

test("a proposal that went stale is refused with an explanation instead of being assigned", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "dispatcher");
  await page.goto("/dispatch?horizon=3");
  const c = card(page, f);
  await expect(c.getByRole("button", { name: "Approve and assign" })).toBeVisible();
  // Meanwhile someone else assigns the load on the board.
  await asUser(USERS.office.email, (q) => q("select public.assign_load($1, $2, null, $3, 'Assigned elsewhere (e2e)', null)", [f.loadId, f.truckId, f.driverId]));
  await c.getByRole("button", { name: "Approve and assign" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This proposal is no longer valid" })).toBeVisible();
  const rows = await asUser(USERS.office.email, (q) => q("select note from public.dispatch_assignments where load_id = $1 and status = 'active'", [f.loadId]));
  expect(rows.rows).toEqual([{ note: "Assigned elsewhere (e2e)" }]);
});

test("people without dispatch.edit cannot approve proposals", async ({ page }) => {
  await signIn(page, "mechanic");
  await page.goto("/dispatch?horizon=3");
  await expect(page.getByRole("button", { name: "Approve and assign" })).toHaveCount(0);
});

test("a two-digit year typed into a date field is saved as this century (date entry regression)", async ({ page }) => {
  await signIn(page, "office");
  const field = page.getByLabel("Quote date");
  // Keys typed before the form has hydrated can be lost on a slow dev server: retry from a fresh page.
  await expect(async () => {
    await page.goto("/quotes/new");
    await field.click({ position: { x: 12, y: 10 } }); // the month segment
    await page.keyboard.type("123126");
    expect(await field.inputValue()).toBe("0026-12-31"); // what the browser holds while typing
  }).toPass({ timeout: 45_000 });
  await page.getByRole("heading", { name: "New quote" }).click(); // leave the field
  await expect(field).toHaveValue("2026-12-31");
  await expect(field).toHaveAttribute("max", "2099-12-31");
});
