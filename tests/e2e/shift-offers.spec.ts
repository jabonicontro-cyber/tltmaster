import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { driverFixture, driverUserId, office } from "./driver-fixture";
import { expectToast, signIn, unique } from "./helpers";
import { USERS } from "./users";

// Shift offers (B102, migration 20261120004700), in the company's "people ask, a planner approves" mode: the owner
// offers a driver shift on the Schedule, the driver asks for it on My Day, the owner approves, and the shift is the
// driver's. The database re-checks everything at each step.

test("an offered shift is asked for on My Day and approved on the Schedule", async ({ page }) => {
  test.slow();
  const id = unique();
  const note = `Extra hauls (e2e ${id})`;
  await driverFixture();
  const userId = await driverUserId();
  const { date, name } = await office(async (q) => {
    const me = (await q("select id from public.drivers where user_id = $1 and active", [userId])).rows[0].id as string;
    const e = await q("select id, full_name from public.employees where user_id = $1", [userId]);
    if (e.rows.length) await q("update public.employees set driver_id = $2, status = 'active' where id = $1", [e.rows[0].id, me]);
    else await q("insert into public.employees (full_name, department, user_id, driver_id) values ('Drew Driver', 'operations', $1, $2)", [userId, me]);
    const who = e.rows.length ? (e.rows[0].full_name as string) : "Drew Driver";
    // A day far enough ahead that earlier runs' shifts (one-day changes) do not collide.
    const d = (await q("select (current_date + 30 + (abs(hashtext($1)) % 300))::text d", [id])).rows[0].d as string;
    return { date: d, name: who };
  });
  await asUser(USERS.owner.email, async (q) => { await q("select public.shift_offer_set_mode('request')"); });

  await signIn(page, "owner");
  await page.goto("/schedule");
  await page.getByRole("button", { name: "Offer a shift" }).click();
  const form = page.getByRole("form", { name: "Offer a shift" });
  await form.getByLabel("Date").fill(date);
  await form.getByLabel("For").selectOption("drivers");
  await form.getByLabel("Note").fill(note);
  await form.getByRole("button", { name: "Offer shift" }).click();
  await expectToast(page, "Shift offered.");
  const offer = page.getByRole("list", { name: "Shift offers" }).getByRole("listitem").filter({ hasText: note }).first();
  await expect(offer).toContainText("No answers yet.");

  await page.context().clearCookies();
  await signIn(page, "driver");
  await page.goto("/driver");
  const mine = page.getByRole("region", { name: "Open shifts" }).getByRole("listitem").filter({ hasText: note });
  await mine.getByRole("button", { name: "Ask for this shift" }).click();
  await expectToast(page, "Asked. A planner will decide.");
  await expect(mine).toContainText("Asked — waiting");

  await page.context().clearCookies();
  await signIn(page, "owner");
  await page.goto("/schedule");
  await offer.getByRole("button", { name: `Approve ${name}` }).click();
  await expectToast(page, "Shift given. It is on the Schedule.");
  await expect(offer).toContainText(`Filled by ${name}`);

  await page.context().clearCookies();
  await signIn(page, "driver");
  await page.goto("/driver");
  await expect(page.getByRole("region", { name: "Open shifts" }).getByRole("listitem").filter({ hasText: note })).toContainText("Got the shift");
});
