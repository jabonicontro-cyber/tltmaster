import { expect, test, type Locator } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Credit holds (B128; owner 2026-11-02: warn, and a reason to proceed), end to end: billing puts a fictional customer
// on hold from the customer page; the dispatch board marks the order; assigning a load asks for a reason, then goes
// ahead and records it; billing releases the hold.

async function choose(select: Locator, prefix: string) {
  const value = await select.locator("option", { hasText: prefix }).first().getAttribute("value");
  await select.selectOption(value!);
}

const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

test("billing holds a customer; dispatch sees it and gives a reason to assign; billing releases it", async ({ page }) => {
  test.slow();
  const id = unique();
  const date = plusDays(30 + (Date.now() % 150));
  const truck = `CRH-${id}`;
  const driver = `Credit Driver ${id}`;
  const customerName = `Credit Hold Co ${id} (test)`;
  const f = await asUser(USERS.office.email, async (q) => {
    const far = plusDays(600);
    const verified = new Date().toISOString();
    await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump')", [truck]);
    const d = (await q("insert into public.drivers (name) values ($1) returning id", [driver])).rows[0].id;
    await q("insert into public.driver_qualifications (driver_id, kind, cdl_class, expires_on, verified_at) values ($1, 'cdl', 'A', $2, $3)", [d, far, verified]);
    await q("insert into public.driver_qualifications (driver_id, kind, expires_on, verified_at) values ($1, 'medical_card', $2, $3)", [d, far, verified]);
    const customer = (await q("insert into public.customers (name, customer_number) values ($1, $2) returning id", [customerName, `CRH${id}`.slice(0, 20)])).rows[0].id as string;
    const r = (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({ customer_id: customer, project_name: `Credit e2e ${id}`, site_line1: "7 Ledger Road", site_city: "Crown Point", lines: [{ kind: "other", calc_method: "per_unit", description: "Hauling (e2e)", unit_code: "load", quantity: "1", unit_rate_cents: 10000 }] })])).rows[0].r;
    await q("select public.set_order_status($1, 'confirmed', '')", [r.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [r.order_id, JSON.stringify({ scheduled_start: date, window_start: "07:00", window_end: "15:00" })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [r.order_id]);
    await q("select public.save_order_load($1::jsonb)", [JSON.stringify({ order_id: r.order_id, load_date: date, start_time: "08:00", end_time: "10:00" })]);
    return { customer, orderNumber: r.order_number as string };
  });

  // Billing (the owner) puts the customer on hold, with a reason.
  await signIn(page, "owner");
  await page.goto(`/customers/${f.customer}`);
  await expect(page.getByText("In good standing")).toBeVisible();
  await page.getByRole("button", { name: "Put on credit hold…" }).click();
  await page.getByLabel("Why is the customer on hold?").fill("Two invoices 60 days late (test)");
  await page.getByRole("button", { name: "Put on hold", exact: true }).click();
  await expectToast(page, /On credit hold/);
  await expect(page.getByText("On credit hold").first()).toBeVisible();

  // Dispatch: the order is marked; assigning asks for a reason first, then goes ahead.
  await signIn(page, "dispatcher");
  await page.goto(`/dispatch?date=${date}`);
  const orderCard = page.locator("section").filter({ has: page.getByRole("link", { name: f.orderNumber, exact: true }) });
  await expect(orderCard.getByText("Credit hold", { exact: true }).first()).toBeVisible();
  await orderCard.getByRole("button", { name: "Assign", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  // The hold shows as soon as the window opens (first-day finding 2026-11-09), says who decides, and the pre-check is
  // never a green "can be assigned" next to it.
  await expect(dialog.getByText(/is on credit hold \(put on hold by billing\): Two invoices 60 days late \(test\)\.$/)).toBeVisible();
  await expect(dialog.getByText(/Billing decides on credit holds/)).toBeVisible();
  await choose(dialog.getByLabel("Truck"), truck);
  await choose(dialog.getByLabel("Driver"), driver);
  await expect(dialog.getByText("This combination can be assigned.")).toHaveCount(0);
  await expect(dialog.getByText(/The credit hold above still needs a reason/)).toBeVisible();
  await expect(dialog.getByLabel("Note (optional)")).toHaveCount(0);
  const anyway = dialog.getByRole("button", { name: "Assign anyway" });
  await expect(anyway).toBeDisabled();
  await dialog.getByLabel("Reason for going ahead").fill("Owner approved by phone (test)");
  await anyway.click();
  await expectToast(page, "Load assigned.");
  await expect(orderCard.getByText(truck)).toBeVisible();

  const recorded = await asUser(USERS.owner.email, async (q) => (await q("select reason, context from public.credit_hold_overrides where customer_id = $1", [f.customer])).rows);
  expect(recorded).toEqual([{ reason: "Owner approved by phone (test)", context: "assignment" }]);

  // Billing releases the hold.
  await signIn(page, "owner");
  await page.goto(`/customers/${f.customer}`);
  await page.getByRole("button", { name: "Release hold" }).click();
  await expectToast(page, "Credit hold released.");
  await expect(page.getByText("In good standing")).toBeVisible();
});
