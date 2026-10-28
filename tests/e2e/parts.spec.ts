import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Shop parts inventory (B105, migration 20261120004500): the owner adds a part and receives stock with a cost; a
// mechanic uses parts on an open work order and cannot take more than is on hand; the work order shows the parts used.

test("parts are received, used on a work order and never go below zero", async ({ page }) => {
  test.slow();
  const id = unique();
  const name = `Air filter ${id}`;
  const wo = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`PT-${id}`.slice(0, 20)])).rows[0].id as string;
    return (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title: `Service (e2e ${id})`, category: "preventive" })])).rows[0].r.id as string;
  });

  await signIn(page, "owner");
  await page.goto("/maintenance/parts");
  await page.getByRole("button", { name: "Add part" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.getByRole("dialog").getByLabel("Reorder at").fill("2");
  await page.getByRole("dialog").getByRole("button", { name: "Add part" }).click();
  await expectToast(page, "Part added.");
  const row = page.getByRole("table", { name: "Parts" }).getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: `Receive ${name}` }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: /Quantity/ }).fill("3");
  await page.getByRole("dialog").getByLabel("Unit cost ($)").fill("24.50");
  await page.getByRole("dialog").getByRole("button", { name: "Receive" }).click();
  await expectToast(page, "Stock received.");
  await expect(row).toContainText("3 each");
  await expect(row).toContainText("$24.50");

  // A mechanic uses 2 on the work order; a third use of 2 is refused (only 1 on hand).
  await page.context().clearCookies();
  await signIn(page, "mechanic");
  await page.goto(`/maintenance/work-orders/${wo}?tab=parts`);
  const form = page.getByRole("form", { name: "Use a part" });
  await form.getByLabel("Part").selectOption({ label: `${name} (3 each on hand)` });
  await form.getByLabel("Quantity").fill("2");
  await form.getByRole("button", { name: "Use part" }).click();
  await expectToast(page, "Part used and added to the work order's costs.");
  await expect(page.getByRole("list", { name: "Parts used" })).toContainText(name);
  await page.getByRole("form", { name: "Use a part" }).getByLabel("Part").selectOption({ label: `${name} (1 each on hand)` });
  await page.getByRole("form", { name: "Use a part" }).getByLabel("Quantity").fill("2");
  await page.getByRole("form", { name: "Use a part" }).getByRole("button", { name: "Use part" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Only 1 each on hand." })).toBeVisible();
  // Mechanics see stock but not costs.
  await page.goto("/maintenance/parts");
  await expect(page.getByRole("table", { name: "Parts" }).getByRole("row").filter({ hasText: name })).toContainText("1 each");
  await expect(page.getByText("Stock value")).toHaveCount(0);
});
