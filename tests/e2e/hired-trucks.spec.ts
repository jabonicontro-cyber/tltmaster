// Hired trucks (B83): the add-on page, a hauler with its documents, truck and driver, an offer refused while a document
// is missing, sent once it is on file, answered by phone, confirmed (assigned through dispatch) and shown in hauler pay.
import pg from "pg";
import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
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

/** An open load the day after tomorrow on a fresh scheduled order (owner's own session). */
async function openLoad(id: string) {
  return asUser(USERS.owner.email, async (q) => {
    const day = (await q("select ((now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date + 2)::text as d")).rows[0].d as string;
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
    const mats = await q("select id from public.materials where code = 'GRV-53' and company_id = $1", [TOP_LINE]);
    const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, project_name: `Hired e2e ${id}`,
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mats.rows[0].id, description: "Gravel #53 limestone", unit_code: "ton", quantity: "22", unit_rate_cents: 1000 }],
    })]);
    const o = r.rows[0].r as { order_id: string; order_number: string };
    await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
    await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: day, scheduled_end: day })]);
    await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
    await q("select public.save_order_load($1::jsonb)", [JSON.stringify({ order_id: o.order_id, load_date: day, start_time: "13:00", end_time: "14:00", planned_quantity: "22", unit_code: "ton" })]);
    return o.order_number;
  });
}

test.afterAll(async () => {
  await admin((c) => c.query("delete from private.hired_trucks_entitlements where company_id = $1", [TOP_LINE]));
});

test("an owner sets up a hauler, offers a load only once documents are current, and confirms it", async ({ page }) => {
  const id = unique();
  const orderNumber = await openLoad(id);
  await admin((c) => c.query("delete from private.hired_trucks_entitlements where company_id = $1", [TOP_LINE]));

  await signIn(page, "owner");
  await page.goto("/hired-trucks");
  await expect(page.getByText("Not switched on for this company")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add hauler" })).toHaveCount(0);

  // The platform owner switches it on (console); the Dispatch page then links to it.
  await admin((c) => c.query("insert into private.hired_trucks_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [TOP_LINE]));
  await page.goto("/dispatch");
  await page.getByRole("link", { name: "Hired trucks" }).click();
  await expect(page).toHaveURL(/\/hired-trucks/);

  const name = `Ridgeline ${id}`;
  const form = page.getByRole("form", { name: "Add a hauler" });
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Contact").fill("Pat");
  await form.getByRole("button", { name: "Add hauler" }).click();
  const card = page.getByRole("region", { name: `Hauler ${name}` });
  await expect(card).toBeVisible();

  const truckForm = page.getByRole("form", { name: `Add a truck for ${name}` });
  await truckForm.getByLabel("Unit number").fill(`H${id}`.slice(0, 10));
  await truckForm.getByRole("button", { name: "Add truck" }).click();
  await expect(card.getByRole("link", { name: /^Truck H/ })).toBeVisible();
  const driverForm = page.getByRole("form", { name: `Add a driver for ${name}` });
  await driverForm.getByLabel("Driver name").fill(`Casey ${id}`);
  await driverForm.getByRole("button", { name: "Add driver" }).click();
  await expect(page.getByRole("link", { name: `Casey ${id}` })).toBeVisible();
  // Qualifications are recorded on the driver page as for any driver (fixture shortcut here).
  await asUser(USERS.owner.email, async (q) => {
    const d = (await q("select id from public.drivers where name = $1", [`Casey ${id}`])).rows[0].id;
    for (const kind of ["cdl", "medical_card"]) await q("insert into public.driver_qualifications (driver_id, kind, cdl_class, expires_on, verified_at) values ($1, $2, $3, current_date + 300, now())", [d, kind, kind === "cdl" ? "A" : null]);
  });

  // Documents: everything but the W-9.
  const docForm = () => page.getByRole("form", { name: `Record a document for ${name}` });
  const record = async (kind: string, truck: boolean, expires: string | null) => {
    await docForm().getByLabel("Document").selectOption({ label: kind });
    if (truck) await docForm().getByLabel("Truck (registration and inspection)").selectOption({ index: 1 });
    if (expires) await docForm().getByLabel("Expires on").fill(expires);
    await docForm().getByRole("button", { name: "Record document" }).click();
    // Wait for this document's row to be on file (the page reloads with the new state).
    await expect(card.getByRole("listitem").filter({ hasText: kind }).first()).not.toContainText("Missing");
  };
  const nextYear = `${new Date().getFullYear() + 1}-06-30`;
  await record("Certificate of insurance", false, nextYear);
  await record("Subcontractor agreement", false, null);
  await record("Truck registration", true, nextYear);
  await record("Truck inspection", true, nextYear);
  await expect(card.getByText("1 document to fix")).toBeVisible();

  // Not ready: the crew is listed but cannot be chosen.
  const offer = page.getByRole("form", { name: "Offer a load" });
  await expect(offer.locator("option", { hasText: name })).toHaveAttribute("disabled", "");
  await expect(offer.locator("option", { hasText: name })).toContainText("documents missing or expired");
  await record("W-9", false, null);
  await expect(card.getByText("Ready for offers")).toBeVisible();

  const optionText = async (field: string, text: string) => (await offer.getByLabel(field).locator("option", { hasText: text }).first().textContent())!;
  await offer.getByLabel("Load").selectOption({ label: await optionText("Load", orderNumber) });
  await offer.getByLabel("Hired truck and driver").selectOption({ label: await optionText("Hired truck and driver", name) });
  await offer.getByLabel("Rate ($)").fill("14.50");
  await offer.getByRole("button", { name: "Send the offer" }).click();
  const pending = page.getByRole("listitem", { name: new RegExp(`Offer for ${orderNumber}`) });
  await expect(pending).toContainText("Waiting for the hauler");
  await expect(pending).toContainText("$14.50 per ton");

  await pending.getByRole("button", { name: "Accepted by phone" }).click();
  await expect(pending).toContainText("Accepted — confirm it");
  await pending.getByRole("button", { name: "Confirm and assign" }).click();
  await expect(page.getByText("Confirmed: the load is assigned to the hired truck.").first()).toBeVisible();
  const pay = page.getByRole("table", { name: "Hauler pay" });
  await expect(pay.getByRole("row").filter({ hasText: orderNumber })).toContainText("No accepted ticket yet.");
});

test("another company's owner does not see this company's haulers", async ({ page }) => {
  await signIn(page, "otherOwner");
  await page.goto("/hired-trucks");
  await expect(page.getByText(/Ridgeline /)).toHaveCount(0);
});
