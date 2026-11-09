import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Shop records (2026-11-09): parts on order before work starts and on the Maintenance overview (20261120012300), the
// annual inspection updating the truck's certificate (20261120012400), an outside repair's invoice and warranty
// (20261120012500), a part returned to stock (20261120012600) and the printable weekly shop report.

test("a job waits for parts before work starts; the overview says when the part is expected", async ({ page }) => {
  const id = unique();
  const title = `Mirror bracket (e2e ${id})`;
  const wo = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`SR-${id}`.slice(0, 20)])).rows[0].id as string;
    return (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title })])).rows[0].r.id as string;
  });
  await signIn(page, "owner");
  await page.goto(`/maintenance/work-orders/${wo}`);
  // Reported, not started: "Waiting for parts" is offered.
  await page.getByRole("button", { name: "Waiting for parts" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Which part?").fill("Mirror bracket");
  await dialog.getByLabel("Expected").fill("2099-03-02");
  await dialog.getByText(/Vendor, PO number/).click();
  await dialog.getByLabel("Vendor").fill("Fictional Parts Co");
  await dialog.getByLabel("PO number").fill(`PO-${id}`.slice(0, 20));
  await dialog.getByLabel("Price each ($)").fill("42.10");
  await dialog.getByRole("button", { name: "Mark waiting for parts" }).click();
  await expectToast(page, /Waiting for parts/);
  const onOrder = page.getByRole("list", { name: "Parts on order" });
  await expect(onOrder).toContainText("Mirror bracket");
  await expect(onOrder).toContainText("From Fictional Parts Co");
  await expect(onOrder).toContainText("$42.10 each");

  await page.goto("/maintenance");
  await expect(page.getByTestId("parts-waiting")).toContainText(/Waiting for parts/);

  // The part is in: received as a cost line, and the job goes back to the queue.
  await page.goto(`/maintenance/work-orders/${wo}?tab=order`);
  await page.getByRole("list", { name: "Parts on order" }).getByRole("button", { name: "Part is in" }).click();
  await page.getByRole("button", { name: "Mark received" }).click();
  await expectToast(page, "Part received. The job is back in the shop queue.");
  await page.goto(`/maintenance/work-orders/${wo}?tab=costs`);
  await expect(page.getByRole("table")).toContainText("Mirror bracket");
});

test("an outside repair records the vendor invoice and warranty; an annual inspection updates the certificate", async ({ page }) => {
  const id = unique();
  const { insp, repair, truck } = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`SI-${id}`.slice(0, 20)])).rows[0].id as string;
    const insp = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title: `Annual DOT inspection (e2e ${id})`, category: "inspection" })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'in_progress', '')", [insp]);
    await q("select public.maintenance_set_status($1, 'completed', '')", [insp]);
    const repair = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title: `Radiator (e2e ${id})` })])).rows[0].r.id as string;
    return { insp, repair, truck };
  });
  await signIn(page, "owner");

  await page.goto(`/maintenance/work-orders/${repair}?tab=costs`);
  await page.getByLabel("Kind").selectOption("vendor");
  await page.getByLabel("Description").fill("Radiator re-core at the radiator shop");
  await page.getByLabel("Unit cost ($)").fill("645.00");
  await page.getByLabel("Vendor invoice number").fill("INV-7781");
  await page.getByLabel("Invoice date").fill("2026-11-02");
  await page.getByLabel("Warranty until").fill("2099-05-01");
  await page.getByRole("button", { name: "Add cost" }).click();
  await expectToast(page, "Cost added.");
  await expect(page.getByRole("table")).toContainText("Vendor invoice INV-7781");
  await expect(page.getByRole("table")).toContainText("Under warranty until May 1, 2099");

  await page.goto(`/maintenance/work-orders/${insp}`);
  await expect(page.getByRole("heading", { name: "Inspection certificate" })).toBeVisible();
  await page.getByLabel("Inspector").fill("Pat Inspector");
  await page.getByLabel("Sticker or certificate number").fill("STK-1");
  await page.getByRole("button", { name: /Update the truck's inspection/ }).click();
  await expectToast(page, "Inspection certificate updated.");
  await expect(page.getByText(/Annual inspection recorded on Truck SI-/)).toBeVisible();
  await page.goto(`/fleet/trucks/${truck}`);
  await expect(page.getByText("Pat Inspector").first()).toBeVisible();
});

test("a part used on a job goes back to stock, and the weekly shop report prints in light colours", async ({ page }) => {
  const id = unique();
  const name = `Wiper blade ${id}`;
  const wo = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`SP-${id}`.slice(0, 20)])).rows[0].id as string;
    const part = (await q("select public.part_save(null, $1::jsonb) id", [JSON.stringify({ name })])).rows[0].id as string;
    await q("select public.part_receive($1, 4, 1250, 'e2e')", [part]);
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title: `Wipers (e2e ${id})` })])).rows[0].r.id as string;
    await q("select public.part_use($1, $2, 2)", [part, wo]);
    return wo;
  });
  await signIn(page, "owner");
  await page.goto(`/maintenance/work-orders/${wo}?tab=parts`);
  await page.getByRole("list", { name: "Parts used" }).getByRole("button", { name: "Return to stock" }).click();
  await page.getByLabel(/How many/).fill("1");
  await page.getByLabel("Why?").fill("Only one was worn");
  await page.getByRole("button", { name: "Return to stock" }).last().click();
  await expectToast(page, "Back in stock. Its cost came off this job.");
  await expect(page.getByRole("list", { name: "Parts used" })).toContainText(`Returned to stock: ${name}`);

  await page.goto("/maintenance/weekly");
  await expect(page.getByRole("heading", { name: /^Shop week of/ })).toBeVisible();
  const report = page.getByRole("article", { name: "Weekly shop report" });
  await expect(report).toHaveClass(/force-light/);
  await expect(report.getByRole("region", { name: /^Opened/ })).toContainText(`Wipers (e2e ${id})`);
  await page.getByRole("button", { name: "Week before" }).or(page.getByRole("link", { name: "Week before" })).click();
  await expect(page).toHaveURL(/week=\d{4}-\d{2}-\d{2}/);
});
