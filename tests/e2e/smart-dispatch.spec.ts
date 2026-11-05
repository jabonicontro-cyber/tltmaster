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
/** Smart Dispatch shows the most urgent few loads first; open the full list so the fixture's load is on the page. */
async function showAll(page: Page) {
  const more = page.getByRole("button", { name: /^Show all \d+ loads$/ });
  if (await more.isVisible().catch(() => false)) await more.click();
}

test("a dispatcher approves a proposal: it is assigned with an audit note, and nothing is assigned before approval", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "dispatcher");
  await page.goto("/dispatch?horizon=3");
  await showAll(page);
  const c = card(page, f);
  await expect(c.getByText("Proposed:")).toBeVisible();
  // Showing a proposal assigns nothing.
  const before = await asUser(USERS.office.email, (q) => q("select count(*)::int as n from public.dispatch_assignments where load_id = $1", [f.loadId]));
  expect(before.rows[0].n).toBe(0);

  await c.getByRole("button", { name: "Approve and assign" }).click();
  // Hours of service are not in Taviron: the dispatcher confirms them before anything is assigned.
  const confirm = page.getByRole("dialog", { name: "Confirm hours of service" });
  await expect(confirm).toContainText("Taviron did not verify them");
  await confirm.getByRole("button", { name: "I checked, assign" }).click();
  await expectToast(page, new RegExp(`${f.orderNumber} load 1: assigned to truck`));
  await expect(c).toHaveCount(0);
  const after = await asUser(USERS.office.email, (q) => q("select note from public.dispatch_assignments where load_id = $1 and status = 'active'", [f.loadId]));
  expect(after.rows).toEqual([{ note: "Approved Smart Dispatch proposal; hours of service confirmed by the dispatcher (not verified by Taviron)" }]);
});

test("suggested crew on the board (B136): one click and the hours confirmation assign the load; Assign still opens the full window", async ({ page }) => {
  test.setTimeout(120_000);
  const f = await fixture();
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${plusDays(1)}&horizon=3`);
  const row = page.locator(`#load-${f.loadId}`);
  await row.scrollIntoViewIfNeeded();
  const suggested = row.getByRole("button", { name: /^Assign load 1 to truck .+ and .+$/ });
  await expect(suggested).toBeVisible({ timeout: 30_000 });
  // The full window is still one click away.
  await row.getByRole("button", { name: "Assign", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  // Nothing is assigned until the dispatcher confirms the hours.
  await suggested.click();
  const confirm = page.getByRole("dialog", { name: "Confirm hours of service" });
  await expect(confirm).toContainText("Taviron did not verify them");
  const before = await asUser(USERS.office.email, (q) => q("select count(*)::int as n from public.dispatch_assignments where load_id = $1", [f.loadId]));
  expect(before.rows[0].n).toBe(0);
  await confirm.getByRole("button", { name: "I checked, assign" }).click();
  await expectToast(page, /Load 1 assigned to truck/);
  const after = await asUser(USERS.office.email, (q) => q("select note from public.dispatch_assignments where load_id = $1 and status = 'active'", [f.loadId]));
  expect(after.rows).toEqual([{ note: "Approved Smart Dispatch proposal; hours of service confirmed by the dispatcher (not verified by Taviron)" }]);
  await expect(row.getByRole("button", { name: "Reassign" })).toBeVisible({ timeout: 30_000 });
});

test("same crew for the order's other loads (B136): offered after an assignment, checked and confirmed before anything is saved", async ({ page }) => {
  test.setTimeout(150_000);
  const f = await fixture();
  // A second load on the same order later that day.
  const second = await asUser(USERS.office.email, async (q) => {
    const r = await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: f.orderId, load_date: plusDays(1), start_time: "05:10", end_time: "06:10", planned_quantity: "18", unit_code: "ton" })]);
    return r.rows[0].r.load_id as string;
  });
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${plusDays(1)}&horizon=3`);
  const row = page.locator(`#load-${f.loadId}`);
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button", { name: /^Assign load 1 to truck .+ and .+$/ }).click({ timeout: 30_000 });
  await page.getByRole("dialog", { name: "Confirm hours of service" }).getByRole("button", { name: "I checked, assign" }).click();
  await page.getByRole("button", { name: "Same crew for the other load" }).click();
  const dialog = page.getByRole("dialog", { name: "Assign 1 load" });
  await expect(dialog).toBeVisible();
  // Nothing is saved until the dispatcher confirms the batch.
  const before = await asUser(USERS.office.email, (q) => q("select count(*)::int as n from public.dispatch_assignments where load_id = $1 and status = 'active'", [second]));
  expect(before.rows[0].n).toBe(0);
  await dialog.getByRole("button", { name: "Assign 1 load" }).click();
  await dialog.getByRole("button", { name: "Done" }).click();
  const rows = await asUser(USERS.office.email, (q) => q("select load_id, truck_id, driver_id from public.dispatch_assignments where load_id = any($1::uuid[]) and status = 'active'", [[f.loadId, second]]));
  expect(rows.rows).toHaveLength(2);
  expect(rows.rows[0].truck_id).toBe(rows.rows[1].truck_id);
  expect(rows.rows[0].driver_id).toBe(rows.rows[1].driver_id);
});

test("rejecting a proposal moves to the next option; reconsidering brings it back", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "dispatcher");
  await page.goto("/dispatch?horizon=3");
  await showAll(page);
  const c = card(page, f);
  const first = (await c.locator("p", { hasText: "Proposed:" }).textContent())!;
  await c.getByRole("button", { name: "Reject…" }).click();
  await c.getByLabel("Reason for rejecting").fill("Driver prefers the north route (e2e)");
  await c.getByRole("button", { name: "Reject this option" }).click();
  // The board recomputes every proposal after a rejection; slow on the dev server with the test database's many trucks.
  await expect(c.getByText("1 option rejected.")).toBeVisible({ timeout: 20_000 });
  await expect(c.locator("p", { hasText: "Proposed:" })).not.toHaveText(first);
  await c.getByRole("button", { name: "Reconsider" }).click();
  // Reconsider triggers the same full recompute as a rejection (about 8 s on the test database; master plan §8 P8).
  await expect(c.getByText("1 option rejected.")).toHaveCount(0, { timeout: 20_000 });
});

test("a proposal that went stale is refused with an explanation instead of being assigned", async ({ page }) => {
  const f = await fixture();
  await signIn(page, "dispatcher");
  await page.goto("/dispatch?horizon=3");
  await showAll(page);
  const c = card(page, f);
  await expect(c.getByRole("button", { name: "Approve and assign" })).toBeVisible();
  // Meanwhile someone else assigns the load on the board.
  await asUser(USERS.office.email, (q) => q("select public.assign_load($1, $2, null, $3, 'Assigned elsewhere (e2e)', null)", [f.loadId, f.truckId, f.driverId]));
  await c.getByRole("button", { name: "Approve and assign" }).click();
  await page.getByRole("dialog", { name: "Confirm hours of service" }).getByRole("button", { name: "I checked, assign" }).click();
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
