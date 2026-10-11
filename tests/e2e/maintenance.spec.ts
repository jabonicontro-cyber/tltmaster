import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Mechanics & Maintenance: work orders, the safety clearance gate, preventive
// schedules, cost visibility and the driver's in-app notice. Fictional data only.

async function newTruck(tag: string) {
  return asUser(USERS.owner.email, async (q) =>
    (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`MX-${tag}`])).rows[0].id as string);
}

const serviceStatus = (truckId: string) =>
  asUser(USERS.owner.email, async (q) => (await q("select service_status::text as s from public.trucks where id = $1", [truckId])).rows[0].s as string);

test("a safety-critical defect restricts the truck until an authorized inspection clears it", async ({ page, browser }) => {
  const tag = unique();
  const truckId = await newTruck(tag);

  await signIn(page, "mechanic");
  await page.goto("/maintenance");
  await expect(page.getByRole("heading", { name: "Maintenance", level: 1 })).toBeVisible();
  await expect(page.getByText("No AI service is connected.")).toBeVisible();
  await page.getByRole("link", { name: "New work order" }).first().click();
  await page.getByRole("combobox", { name: "Truck", exact: true }).selectOption({ label: `MX-${tag}` });
  await page.getByLabel("Title").fill(`Brake chamber cracked ${tag}`);
  await page.getByLabel("Category").selectOption("brakes");
  await page.getByLabel("Urgency").selectOption("immediate");
  await page.getByLabel(/Safety-critical defect/).check();
  await expect(page.getByText("Saving takes the truck out of service")).toBeVisible();
  await page.getByRole("button", { name: "Create work order" }).click();
  await expectToast(page, /Work order WO-\d{4}-\d{4} created/);
  await expect(page.getByText(/is out of service and cannot be dispatched/)).toBeVisible();
  expect(await serviceStatus(truckId)).toBe("out_of_service");
  const woUrl = page.url();

  await page.getByRole("button", { name: "Start work" }).click();
  await expectToast(page, "Status: In progress.");
  await expect(page.getByRole("button", { name: "Mark completed" })).toHaveCount(0); // never directly for safety work
  await page.getByRole("button", { name: "Send for inspection" }).click();
  await expectToast(page, "Status: Awaiting inspection.");
  await expect(page.getByText("Only people allowed to clear vehicles")).toBeVisible();
  await expect(page.getByRole("button", { name: /Passed/ })).toHaveCount(0);

  const owner = await browser.newPage();
  await signIn(owner, "owner");
  await owner.goto("/maintenance/clearance");
  await owner.getByRole("link", { name: new RegExp(`Brake chamber cracked ${tag}`) }).click();
  await owner.getByRole("button", { name: "Failed" }).click();
  await owner.getByRole("button", { name: "Record failure" }).click();
  await expect(owner.getByText("Describe what failed so the shop knows what to fix.")).toBeVisible();
  await owner.getByLabel("What failed").fill("Pushrod stroke out of spec");
  await owner.getByRole("button", { name: "Record failure" }).click();
  await expectToast(owner, "Inspection failed");
  expect(await serviceStatus(truckId)).toBe("out_of_service");

  await page.goto(woUrl);
  await page.getByRole("button", { name: "Send for inspection" }).click();
  await expectToast(page, "Status: Awaiting inspection.");

  await owner.reload();
  await owner.getByRole("button", { name: "Passed — clear for service" }).click();
  await owner.getByLabel("Inspection notes (optional)").fill("Adjusted and road tested");
  await owner.getByRole("button", { name: "Clear for service" }).click();
  await expectToast(owner, "Cleared. The truck is back in service.");
  await expect(owner.getByText("Cleared for service").first()).toBeVisible();
  expect(await serviceStatus(truckId)).toBe("in_service");
  await owner.close();
});

test("preventive schedules flag overdue service and create one work order however often they run", async ({ page }) => {
  const tag = unique();
  await newTruck(tag);
  await signIn(page, "owner");
  await page.goto("/maintenance/preventive");
  const form = page.locator("form", { has: page.getByRole("button", { name: "Add schedule" }) });
  await form.getByLabel("Truck").selectOption({ label: `MX-${tag}` });
  await form.getByLabel("Service").fill(`Oil and filter ${tag}`);
  await form.getByLabel("Every … miles").fill("15000");
  await form.getByRole("button", { name: "Add schedule" }).click();
  await expectToast(page, "Schedule added.");
  const row = page.getByRole("row", { name: new RegExp(`Oil and filter ${tag}`) });
  await expect(row).toContainText("odometer at last service missing");
  await expect(row).toContainText("Not enough data"); // missing data is not shown as fine

  await form.getByLabel("Service").fill(`Annual inspection ${tag}`);
  await form.getByLabel("Truck").selectOption({ label: `MX-${tag}` });
  await form.getByLabel("Every … days").fill("365");
  await form.getByLabel("Last done on").fill("2025-01-15");
  await form.getByRole("button", { name: "Add schedule" }).click();
  await expectToast(page, "Schedule added.");
  await expect(page.getByRole("row", { name: new RegExp(`Annual inspection ${tag}`) })).toContainText("Overdue");

  await page.getByRole("button", { name: "Create work orders for due services" }).click();
  await expectToast(page, /work orders? created/);
  const woLink = page.getByRole("row", { name: new RegExp(`Annual inspection ${tag}`) }).getByRole("link", { name: /^WO-/ });
  await expect(woLink).toBeVisible();
  await page.getByRole("button", { name: "Create work orders for due services" }).click();
  await expectToast(page, "No new work orders: every due service already has one.");

  // Readings never go down.
  const reading = page.locator("form", { has: page.getByRole("button", { name: "Record reading" }) });
  await reading.getByLabel("Truck").selectOption({ label: `MX-${tag}` });
  await reading.getByLabel("Odometer (mi)").fill("120000");
  await reading.getByRole("button", { name: "Record reading" }).click();
  await expectToast(page, "Reading recorded.");
  await reading.getByLabel("Truck").selectOption({ label: `MX-${tag}` });
  await reading.getByLabel("Odometer (mi)").fill("119000");
  await reading.getByRole("button", { name: "Record reading" }).click();
  await expect(page.getByText(/The odometer cannot go down/)).toBeVisible();
});

test("costs are visible only to people with cost access", async ({ page, browser }) => {
  const tag = unique();
  const truckId = await newTruck(tag);
  const wo = await asUser(USERS.owner.email, async (q) =>
    (await q("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify({ truck_id: truckId, title: `Alternator ${tag}` })])).rows[0].r as { id: string });

  await signIn(page, "office");
  await page.goto(`/maintenance/work-orders/${wo.id}`);
  await page.getByLabel("Description").fill("Alternator 160A");
  await page.getByLabel("Vendor").fill("Parts counter");
  await page.getByLabel("Unit cost ($)").fill("415.00");
  await page.getByRole("button", { name: "Add cost" }).click();
  await expectToast(page, "Cost added.");
  await expect(page.getByText("Total $415.00")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start work" })).toHaveCount(0); // office records costs, not shop work

  const mech = await browser.newPage();
  await signIn(mech, "mechanic");
  await mech.goto(`/maintenance/work-orders/${wo.id}`);
  await expect(mech.getByRole("heading", { name: new RegExp(`Alternator ${tag}`) })).toBeVisible();
  await expect(mech.getByText("Parts, labor and costs")).toHaveCount(0);
  await expect(mech.getByText("$415.00")).toHaveCount(0);
  await mech.close();
});

test("the driver of the truck sees scheduled and canceled shop visits on My Day", async ({ page }) => {
  const tag = unique();
  const truckId = await newTruck(tag);
  const driverId = await asUser(USERS.owner.email, async (q) =>
    (await q("select d.id from public.drivers d join public.profiles p on p.id = d.user_id where p.email = $1", [USERS.driver.email])).rows[0].id as string);
  const previous = await asUser(USERS.owner.email, async (q) =>
    (await q("select primary_truck_id from public.drivers where id = $1", [driverId])).rows[0].primary_truck_id as string | null);
  try {
    const wo = await asUser(USERS.owner.email, async (q) => {
      await q("select public.set_driver_primary_truck($1, $2)", [driverId, truckId]);
      const d = (await q("select (current_date + 2)::text as d")).rows[0].d as string;
      return (await q("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify({ truck_id: truckId, title: `Annual DOT ${tag}`, category: "inspection", scheduled_for: d })])).rows[0].r as { id: string };
    });
    await signIn(page, "driver");
    await page.goto("/driver");
    const notices = page.getByRole("region", { name: "Truck maintenance" });
    await expect(notices).toContainText(`Truck MX-${tag}: Annual DOT ${tag}`);
    await expect(notices).toContainText("in the shop on");

    await asUser(USERS.owner.email, (q) => q("select public.maintenance_set_status($1, 'canceled', 'Moved to the dealer')", [wo.id]));
    await page.reload();
    await expect(notices).toContainText("was canceled");
  } finally {
    await asUser(USERS.owner.email, (q) => q("select public.set_driver_primary_truck($1, $2)", [driverId, previous]));
  }
});

test("dispatchers read only; drivers and other companies get no access", async ({ page, browser }) => {
  const tag = unique();
  const truckId = await newTruck(tag);
  const wo = await asUser(USERS.owner.email, async (q) =>
    (await q("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify({ truck_id: truckId, title: `Mirror ${tag}` })])).rows[0].r as { id: string });

  await signIn(page, "dispatcher");
  await page.goto(`/maintenance/work-orders?q=Mirror%20${tag}`);
  await expect(page.getByRole("link", { name: /^WO-/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "New work order" })).toHaveCount(0);
  await page.goto(`/maintenance/work-orders/${wo.id}`);
  await expect(page.getByRole("button", { name: "Start work" })).toHaveCount(0);
  await page.goto("/maintenance/work-orders/new");
  await expect(page).toHaveURL(/\/no-access/);

  const driver = await browser.newPage();
  await signIn(driver, "driver");
  await driver.goto("/maintenance");
  await expect(driver).toHaveURL(/\/no-access/);
  await driver.close();

  const other = await browser.newPage();
  await signIn(other, "otherOwner");
  await other.goto(`/maintenance/work-orders/${wo.id}`);
  await expect(other.getByText("Not found", { exact: true })).toBeVisible();
  await other.close();
});
