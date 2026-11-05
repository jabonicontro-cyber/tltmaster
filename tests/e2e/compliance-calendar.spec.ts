import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { USERS } from "./users";

// Compliance calendar (master plan CC1): a driver's medical card that expires soon and a truck registration that has
// expired show in one list, under the right heading, each linking to its record.

test("the compliance calendar lists what is overdue and what is coming up", async ({ page }) => {
  const id = unique();
  const driverName = `CC-Driver ${id}`;
  const unit = `CC-${id}`.slice(0, 20);
  const ids = await asUser(USERS.owner.email, async (q) => {
    // Dates in the company's own time zone, as the app counts them.
    const today = "(now() at time zone coalesce((select timezone from public.company_settings where company_id = (select private.current_company_id())), 'America/Chicago'))::date";
    const driver = (await q("insert into public.drivers (name) values ($1) returning id", [driverName])).rows[0].id as string;
    await q(`insert into public.driver_qualifications (driver_id, kind, expires_on) values ($1, 'medical_card', (${today} + 10))`, [driver]);
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [unit])).rows[0].id as string;
    await q(`insert into public.vehicle_documents (truck_id, kind, reference_number, expires_on) values ($1, 'registration', 'REG-1', (${today} - 5))`, [truck]);
    return { driver, truck };
  });
  try {
    await signIn(page, "owner");
    await page.goto("/fleet");
    await page.getByRole("navigation", { name: "Fleet sections" }).getByRole("link", { name: "Compliance calendar" }).click();
    const overdue = page.getByRole("table", { name: "Overdue" });
    await expect(overdue.getByRole("row").filter({ hasText: `Truck ${unit}` })).toContainText("Registration expires");
    await expect(overdue.getByRole("row").filter({ hasText: `Truck ${unit}` })).toContainText("5 days overdue");
    const soon = page.getByRole("table", { name: "Next 30 days" });
    const row = soon.getByRole("row").filter({ hasText: driverName });
    await expect(row).toContainText("Medical card expires");
    await expect(row).toContainText("In 10 days");
    await row.getByRole("link", { name: "Medical card expires" }).click();
    await expect(page).toHaveURL(new RegExp(`/fleet/drivers/${ids.driver}$`));
  } finally {
    await asUser(USERS.owner.email, async (q) => {
      await q("update public.drivers set active = false where id = $1", [ids.driver]);
      await q("update public.trucks set active = false where id = $1", [ids.truck]);
    });
  }
});
