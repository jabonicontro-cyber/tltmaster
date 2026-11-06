import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn } from "./helpers";
import { USERS } from "./users";

// Detention (DT1): the customer's free time and hourly rate are set on the customer page; a recorded wait past the free
// time shows on the order's billing page; billing adds it to the order or records why it isn't billed.
const CUSTOMER = "Prairie View Landscaping";

test("billing adds a proposed detention charge and dismisses another with a reason", async ({ browser }) => {
  test.slow();
  const fx = await driverFixture();
  const loads = (await asUser(USERS.office.email, (q) => q("select a.load_id from public.dispatch_assignments a where a.id = any($1::uuid[]) order by a.created_at", [[fx.past, fx.otherAssignment]]))).rows.map((r) => r.load_id as string);
  await asUser(USERS.dispatcher.email, async (q) => {
    await q("select public.load_stop_set($1, 'site', now() - interval '200 minutes', now() - interval '20 minutes')", [loads[0]]);
    await q("select public.load_stop_set($1, 'site', now() - interval '100 minutes', now() - interval '10 minutes')", [loads[1]]);
  });
  const owner = await (await browser.newContext()).newPage();
  try {
    // Turned on per customer on the customer page.
    await signIn(owner, "owner");
    const customerId = (await asUser(USERS.owner.email, (q) => q("select id from public.customers where name = $1", [CUSTOMER]))).rows[0].id as string;
    await owner.goto(`/customers/${customerId}`);
    const panel = owner.getByRole("form", { name: "Detention for this customer" });
    await panel.getByLabel("Free time (minutes)").fill("60");
    await panel.getByLabel("Rate per hour ($)").fill("80");
    await panel.getByRole("button", { name: "Save" }).click();
    await expectToast(owner, "Detention saved.");
    await expect(owner.getByText(/After 60 min at a stop, waiting is billed at \$80\.00 per hour/)).toBeVisible();

    // Billing sees both waits on the order's billing page: 180 min (2.00 h, $160.00) and 90 min (0.50 h, $40.00).
    const office = await (await browser.newContext()).newPage();
    await signIn(office, "office");
    await office.goto(`/billing/orders/${fx.orderId}`);
    const list = office.getByRole("list", { name: "Detention proposals" });
    await expect(list.getByRole("listitem")).toHaveCount(2);
    await expect(office.getByText("2 to review")).toBeVisible();
    const first = list.getByRole("listitem").filter({ hasText: "Waited 3 h 00 min" });
    await expect(first).toContainText("2.00 h × $80.00 = $160.00");
    await first.getByRole("button", { name: "Add to order" }).click();
    await expectToast(office, "Detention added to the order.");
    await expect(first.getByText("Added to the order")).toBeVisible();
    await expect(office.getByText(/Detention: .+, waited 3 h 00 min \(60 min free\)/)).toBeVisible();

    const second = list.getByRole("listitem").filter({ hasText: "Waited 1 h 30 min" });
    await second.getByRole("button", { name: "Don't bill" }).click();
    await second.getByLabel("Why it is not billed").fill("Customer waived it (e2e)");
    await second.getByRole("button", { name: "Record" }).click();
    await expectToast(office, "Recorded as not billed.");
    await expect(second.getByText("Not billed: Customer waived it (e2e)")).toBeVisible();
  } finally {
    await asUser(USERS.owner.email, (q) => q("update public.customers set detention_free_minutes = null, detention_rate_cents = null where name = $1", [CUSTOMER]));
  }
});

test("billing adds a per-occurrence charge (lumper) to a confirmed order", async ({ page }) => {
  const fx = await driverFixture();
  const name = `Lumper e2e ${Date.now().toString(36)}`;
  await asUser(USERS.owner.email, (q) => q("insert into public.charge_items (name, kind, calc_method, default_unit_code, ticket_required) values ($1, 'service', 'per_unit', 'each', false)", [name]));
  try {
    await signIn(page, "office");
    await page.goto(`/billing/orders/${fx.orderId}`);
    const form = page.getByRole("form", { name: "Add a charge" });
    await form.getByLabel("Charge").selectOption({ label: name });
    await form.getByLabel(/^Quantity/).fill("1");
    await form.getByLabel("Rate ($)").fill("85");
    await form.getByLabel("Note (on the invoice)").fill("Receiver unload fee");
    await form.getByRole("button", { name: "Add" }).click();
    await expectToast(page, "Charge added to the order.");
    await expect(page.getByText(`${name}: Receiver unload fee`).first()).toBeVisible();
  } finally {
    await asUser(USERS.owner.email, (q) => q("update public.charge_items set active = false where name = $1", [name]));
  }
});
