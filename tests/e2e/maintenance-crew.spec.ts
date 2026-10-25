import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Crews, labor time and checklists on a work order (20261120002900): a mechanic starts and stops work, a second
// mechanic's time is logged after the fact, overlapping time is refused, and the checklist is ticked off.

test("a mechanic works a job with a crew, timer, logged time and checklist", async ({ page }) => {
  const title = `Crew test ${unique()}`;
  const { id } = await asUser(USERS.mechanic.email, async (q) => {
    const truck = (await q("select id from public.trucks where active and service_status = 'in_service' order by unit_number limit 1")).rows[0].id as string;
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title, category: "brakes" })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'in_progress')", [wo]);
    return { id: wo };
  });

  await signIn(page, "mechanic");
  await page.goto(`/maintenance/work-orders/${id}`);
  const crew = page.getByRole("list").filter({ has: page.getByText("No mechanic assigned yet.") });
  await expect(crew).toBeVisible();

  // Starting work puts the mechanic on the crew as working; a second start elsewhere is not offered.
  await page.getByRole("button", { name: "Start work" }).click();
  await expectToast(page, "Timer started.");
  await expect(page.getByText(/Working · 0 h/)).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expectToast(page, "Timer stopped.");

  // Add the owner's time after the fact (owners can do maintenance in the default roles) and refuse an overlap.
  await page.getByLabel("Add a mechanic").selectOption({ label: USERS.owner.name });
  await page.getByRole("button", { name: "Add to crew" }).click();
  await expectToast(page, "Mechanic added.");
  // Yesterday in the company's time zone, so the times are never in the future.
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(Date.now() - 86400000));
  const logTime = async (start: string, end: string) => {
    await page.getByRole("button", { name: "Log time" }).click();
    const form = page.getByRole("form", { name: "Log time" });
    await form.getByLabel("Mechanic").selectOption({ label: USERS.owner.name });
    await form.getByLabel("Date").fill(yesterday);
    await form.getByLabel("Start time").fill(start);
    await form.getByLabel("End time").fill(end);
    await form.getByRole("button", { name: "Save time" }).click();
  };
  await logTime("00:10", "01:40");
  await expectToast(page, "Time logged.");
  await expect(page.getByText(/Labor · 1 h 3\d min/)).toBeVisible();
  await logTime("01:00", "02:00");
  await expectToast(page, /already has time logged/);
  await page.getByRole("form", { name: "Log time" }).getByRole("button", { name: "Cancel" }).click();

  // Checklist.
  await page.getByLabel("New task").fill("Cage the spring brake");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expectToast(page, "Task added.");
  await page.getByRole("button", { name: 'Mark "Cage the spring brake" done' }).click();
  await expectToast(page, "Task updated.");
  await expect(page.getByText("1 of 1 done")).toBeVisible();

  // The history records it all.
  await expect(page.getByText("Labor time").first()).toBeVisible();
  await expect(page.getByText("Task added: Cage the spring brake")).toBeVisible();
});

test("shop capacity: set up the shop, record skills, and estimate a job", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/maintenance/shop");
  await expect(page.getByRole("link", { name: "Shop capacity" })).toHaveAttribute("aria-current", "page");
  const form = page.getByRole("form", { name: "Shop settings" });
  await form.getByLabel("Service bays").fill("3");
  await form.getByRole("button", { name: /Set up the shop|Save shop settings/ }).click();
  await expectToast(page, "Shop settings saved.");
  await expect(page.getByRole("table")).toContainText("Mechanics");
  await expect(page.getByRole("table")).toContainText("/ 3");

  // A skill for the mechanic.
  const skills = page.getByRole("group", { name: `${USERS.mechanic.name}'s skills` });
  const brakes = skills.getByRole("button", { name: "Brakes" });
  const wasOn = (await brakes.getAttribute("aria-pressed")) === "true";
  await brakes.click();
  await page.getByRole("listitem").filter({ has: skills }).getByRole("button", { name: "Save" }).click();
  await expectToast(page, "Skills saved.");
  await expect(brakes).toHaveAttribute("aria-pressed", wasOn ? "false" : "true");

  // An estimate on a work order.
  const { id } = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("select id from public.trucks where active order by unit_number limit 1")).rows[0].id as string;
    return { id: (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title: `Estimate ${unique()}`, category: "tires" })])).rows[0].r.id as string };
  });
  await page.goto(`/maintenance/work-orders/${id}`);
  await page.getByLabel("Estimated hours").fill("3.5");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expectToast(page, "Estimate saved.");
  await expect(page.getByText("Estimate: 3.5 h")).toBeVisible();
});
