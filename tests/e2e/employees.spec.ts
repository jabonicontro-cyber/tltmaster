import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Employees: a real directory with employment records, confidential pay that
// only the right permission sees, and drivers' primary trucks set by people who
// may assign trucks. Fictional data only.

test("office adds an employee, finds them by search and filter, and edits the record; pay stays hidden", async ({ page }) => {
  const name = `Morgan Loader ${unique()}`;
  await signIn(page, "office");
  await page.goto("/employees");
  await expect(page.getByRole("heading", { name: "People", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "Add person" }).first().click();
  await expect(page.getByLabel("Send them a Taviron sign-in")).toHaveCount(0); // office does not manage users

  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Job title").fill("Loader operator");
  await page.getByLabel("Department").selectOption("shop");
  await page.getByLabel("Work phone").fill("3125550142");
  await expect(page.getByLabel("Work phone")).toHaveValue("(312) 555-0142");
  await page.locator("label", { has: page.getByLabel("Avatar 10") }).click(); // people click the picture
  await expect(page.getByLabel("Avatar 10")).toBeChecked();
  await page.getByLabel("Status").selectOption("terminated");
  await page.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByText("Enter the last day of employment.")).toBeVisible(); // kept input, explained
  await expect(page.getByLabel("Full name")).toHaveValue(name);
  await page.getByLabel("Status").selectOption("active");
  await page.getByRole("button", { name: "Add person" }).click();
  await expectToast(page, "Person added.");
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("Pay (confidential)")).toHaveCount(0); // office has no pay permission
  await expect(page.locator("main img[src='/avatars/avatar-10.png']")).toBeVisible(); // no login, so the chosen avatar

  await page.goto(`/employees?q=${encodeURIComponent(name)}&department=shop`);
  await expect(page.getByRole("link", { name })).toBeVisible();
  await page.goto(`/employees?q=${encodeURIComponent(name)}&department=dispatch`);
  await expect(page.getByText("No one matches these filters")).toBeVisible();
});

test("the owner adds a person with a sign-in (ticked by default); the login lands on that record and its access is changed there", async ({ page }) => {
  const id = unique();
  const name = `Pat People ${id}`;
  const email = `pat-${id}@people.test`;
  await signIn(page, "owner");
  await page.goto("/employees/new");
  const send = page.getByLabel("Send them a Taviron sign-in");
  await expect(send).toBeChecked();
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Role").selectOption("office");
  await page.getByRole("button", { name: "Add person" }).click();
  await expect(page.getByText("Enter a work email to send a sign-in, or untick it.").first()).toBeVisible();
  await send.uncheck();
  await expect(page.getByLabel("Role")).toHaveCount(0);
  await send.check();
  await page.getByLabel("Role").selectOption("office");
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Add person" }).click();
  await expectToast(page, `Person added. Invitation sent to ${email}.`);
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText(/Signs in as Office staff/)).toBeVisible();

  // One record, linked to the new login (no duplicate created by the database).
  const rows = await asUser(USERS.owner.email, async (q) => (await q("select user_id from public.employees where lower(work_email) = $1", [email])).rows);
  expect(rows).toHaveLength(1);
  expect(rows[0].user_id).toBeTruthy();

  await page.goto(`/employees?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("Office staff");

  // Access is changed on the person's page; turning it off leaves the fixture company as it was.
  await page.getByRole("link", { name }).click();
  await page.getByRole("button", { name: "Change role or access" }).click();
  await page.getByRole("dialog").getByLabel(/Account active/).uncheck();
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expectToast(page, "User updated.");
  await expect(page.getByText("Sign-in turned off")).toBeVisible();
});

test("Sign-ins & roles lives on People; the old Settings → Users link still works", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/settings?tab=users");
  await expect(page).toHaveURL(/\/employees\?.*view=access/);
  await expect(page.getByRole("link", { name: "Sign-ins & roles" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Invite user" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Users" })).toHaveCount(0);

  await signIn(page, "dispatcher");
  await page.goto("/employees?view=access");
  await expect(page.getByRole("link", { name: "Sign-ins & roles" })).toHaveCount(0); // users.manage only
  await expect(page.getByRole("button", { name: "Invite user" })).toHaveCount(0);
});

test("the owner sets confidential pay; others never receive it, even by asking the database", async ({ page }) => {
  const name = `Pay Check ${unique()}`;
  const id = await asUser(USERS.owner.email, async (q) => (await q("insert into public.employees (full_name) values ($1) returning id", [name])).rows[0].id as string);
  await signIn(page, "owner");
  await page.goto(`/employees/${id}`);
  await page.getByLabel("Rate ($)").fill("28.75");
  await page.getByRole("button", { name: "Save pay details" }).click();
  await expectToast(page, "Pay details saved.");
  await page.reload();
  await expect(page.getByText("$28.75 / hour")).toBeVisible();

  for (const who of ["office", "dispatcher", "mechanic"] as const) {
    const seen = await asUser(USERS[who].email, async (q) => (await q("select count(*)::int as n from public.employee_compensation where employee_id = $1", [id])).rows[0].n);
    expect(seen, who).toBe(0);
  }
});

test("a dispatcher assigns a driver's primary truck; a truck can be one driver's at a time", async ({ page }) => {
  const tag = unique();
  const setup = await asUser(USERS.owner.email, async (q) => {
    await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump')", [`PT-${tag}`]);
    const d1 = (await q("insert into public.drivers (name) values ($1) returning id", [`Primary One ${tag}`])).rows[0].id as string;
    const d2 = (await q("insert into public.drivers (name) values ($1) returning id", [`Primary Two ${tag}`])).rows[0].id as string;
    const e1 = (await q("insert into public.employees (full_name, driver_id) values ($1, $2) returning id", [`Primary One ${tag}`, d1])).rows[0].id as string;
    const e2 = (await q("insert into public.employees (full_name, driver_id) values ($1, $2) returning id", [`Primary Two ${tag}`, d2])).rows[0].id as string;
    return { e1, e2 };
  });
  await signIn(page, "dispatcher");
  await page.goto(`/employees/${setup.e1}`);
  await page.getByLabel("Primary truck").selectOption({ label: `PT-${tag}` });
  await page.getByRole("button", { name: "Save truck" }).click();
  await expectToast(page, "Primary truck set.");

  await page.goto(`/employees/${setup.e2}`);
  const option = page.getByLabel("Primary truck").locator("option", { hasText: `PT-${tag}` });
  await expect(option).toHaveText(`PT-${tag} — primary truck of Primary One ${tag}`);
  await expect(option).toHaveAttribute("disabled", ""); // not selectable while another driver holds it

  await page.goto(`/employees?q=Primary%20One%20${tag}`);
  await expect(page.getByRole("row", { name: new RegExp(`Primary One ${tag}`) })).toContainText(`Truck PT-${tag}`);
});

test("drivers and other companies cannot open the directory", async ({ page, browser }) => {
  await signIn(page, "driver");
  await page.goto("/employees");
  await expect(page).toHaveURL(/\/no-access/);

  const id = await asUser(USERS.owner.email, async (q) => (await q("insert into public.employees (full_name) values ($1) returning id", [`Top Line Only ${unique()}`])).rows[0].id as string);
  const other = await browser.newPage();
  await signIn(other, "otherOwner");
  await other.goto(`/employees/${id}`);
  await expect(other.getByText("Not found", { exact: true })).toBeVisible();
  await other.close();
});

test("employee pages request only profile photos that exist (no failed image requests)", async ({ page }) => {
  await signIn(page, "owner");
  const failed: string[] = [];
  page.on("response", (r) => { if (r.status() >= 400 && r.url().includes("/people/photo/")) failed.push(r.url()); });
  await page.goto("/employees?status=all");
  await expect(page.getByRole("heading", { name: "People", level: 1 })).toBeVisible();
  const first = page.locator('a[href^="/employees/"]').filter({ hasText: /\w/ }).first();
  await page.goto((await first.getAttribute("href"))!);
  await page.waitForLoadState("load");
  expect(failed).toEqual([]);
});
