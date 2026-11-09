import { expect, test } from "@playwright/test";
import { expectToast, signIn, unique } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// The mechanic's phone workspace (docs/COMPANION_APP.md): My jobs is home, the mechanic tab bar shows on a phone, and
// a job taken from "Needs a mechanic" can be started, timed and finished with the same rules as the work order page.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("a mechanic takes a job on a phone, starts it, waits for a part, times it and finishes it for inspection", async ({ page }) => {
  const title = `My jobs test ${unique()}`;
  await asUser(USERS.owner.email, async (q) => {
    // Its own truck: a safety-critical job restricts the truck, which must not affect other tests' trucks.
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`ZMJ-${unique()}`.slice(0, 20)])).rows[0].id as string;
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title, category: "tires", urgency: "immediate", safety_critical: true })])).rows[0].r.id as string;
    await q("select public.maintenance_set_status($1, 'triaged')", [wo]);
  });

  // A mechanic-only login starts on My jobs, not the Command Center (B2).
  await signIn(page, "mechanic");
  await expect(page).toHaveURL(/\/maintenance\/my-jobs$/);
  await page.goto("/maintenance/my-jobs");
  const tabs = page.getByRole("navigation", { name: "Mechanic tabs" });
  await expect(tabs.getByRole("link", { name: "My jobs" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "All jobs" })).toBeVisible();

  // Take it: the mechanic becomes the lead, the same as being assigned on the work order.
  const open = page.getByRole("listitem").filter({ hasText: title });
  await open.getByRole("button", { name: "Take this job" }).click();
  await expectToast(page, "Lead mechanic set.");
  const mine = page.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "You lead this job" });
  await expect(mine).toBeVisible();
  await expect(mine.getByRole("button", { name: "My part is done" })).toHaveCount(0); // not before the job starts
  await expect(mine.getByRole("button", { name: "Finish the job" })).toHaveCount(0);
  // Plain words: "Work order MWO-…", never the bare code.
  await expect(mine).toContainText(/Work order MWO-/);

  // Each state says the next step in plain words (UX14). Start this job also starts the timer (one tap).
  await expect(mine.getByTestId("next-step")).toHaveText(/^Next: tap Start this job/);
  await mine.getByRole("button", { name: "Start this job" }).click();
  await expectToast(page, "Job started. Your timer is running.");
  await expect(page.getByRole("region", { name: "Your running timer" })).toContainText(/Timer running/);
  await expect(mine.getByTestId("next-step")).toHaveText(/^Your timer is running/);

  // Waiting for parts asks which part; the card shows it, the timer stops, and "done" is not offered while waiting.
  await mine.getByRole("button", { name: "Waiting for parts" }).click();
  await mine.getByLabel("Which part is missing?").fill("Steer tire 315/80R22.5");
  await mine.getByRole("button", { name: "Mark waiting for parts" }).click();
  await expectToast(page, "Waiting for parts. Your timer is stopped.");
  await expect(mine.getByTestId("next-step")).toHaveText("Waiting for parts: Steer tire 315/80R22.5. Start the job again when it is in.");
  await expect(mine.getByRole("button", { name: "My part is done" })).toHaveCount(0);
  await expect(mine.getByRole("button", { name: "Finish the job" })).toHaveCount(0);
  await mine.getByRole("button", { name: "Part is in: start again" }).click();
  await expectToast(page, "Job started. Your timer is running.");

  // A quick note of what was found, kept with the time entry.
  await mine.getByLabel(/What you found or did/).fill("Cut sidewall, left steer tire");
  await mine.getByRole("button", { name: "Stop timer" }).click();
  await expectToast(page, "Timer stopped.");
  await asUser(USERS.owner.email, async (q) => {
    const r = await q("select e.note from public.work_order_time_entries e join public.work_orders w on w.id = e.work_order_id where w.title = $1", [title]);
    expect(r.rows.map((x) => x.note)).toContain("Cut sidewall, left steer tire");
  });
  await expect(page.getByRole("region", { name: "Your running timer" })).toHaveCount(0);

  // The whole card opens the job on its checklist, and the phone's tab bar keeps My jobs lit.
  await mine.click({ position: { x: 24, y: 24 } });
  await expect(page).toHaveURL(/\/maintenance\/work-orders\/[0-9a-f-]{36}\?tab=tasks&from=my-jobs$/);
  await expect(page.getByRole("navigation", { name: "Work order sections" }).getByRole("link", { name: /^Checklist/ })).toHaveAttribute("aria-current", "page");
  await expect(tabs.getByRole("link", { name: "My jobs" })).toHaveAttribute("aria-current", "page");
  await page.goto("/maintenance/my-jobs");

  // The lead finishes in one step: say what was fixed; a safety-critical job goes for inspection (never completed
  // directly) and the truck stays out of service.
  // No double entry (I8): the note kept with the timer starts "What did you fix?", and the odometer goes in the same step.
  await mine.getByRole("button", { name: "Finish the job" }).click();
  await expect(mine.getByLabel("What did you fix?")).toHaveValue("Cut sidewall, left steer tire");
  await mine.getByLabel("What did you fix?").fill("Replaced the left steer tire");
  await mine.getByLabel("Odometer now (optional)").fill("184,250");
  await mine.getByRole("button", { name: "Send for inspection" }).click();
  await expectToast(page, /^Sent for inspection\. The truck stays out of service/);
  await asUser(USERS.owner.email, async (q) => {
    const r = await q("select w.status, w.findings, w.odometer_at_service::float as odometer, t.service_status from public.work_orders w join public.trucks t on t.id = w.truck_id where w.title = $1", [title]);
    expect(r.rows[0]).toMatchObject({ status: "awaiting_inspection", findings: "Replaced the left steer tire", odometer: 184250, service_status: "out_of_service" });
  });
  await expect(page.getByRole("listitem").filter({ hasText: title }).filter({ hasText: "You lead this job" })).toHaveCount(0);
});

test("a fresh driver defect (Reported) needs a mechanic, safety-critical first, and Start work leads it on the work order", async ({ page }) => {
  const title = `Fresh defect ${unique()}`;
  const { id } = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`ZFD-${unique()}`.slice(0, 20)])).rows[0].id as string;
    // Left as reported: nobody has triaged it yet.
    return { id: (await q("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: truck, title, description: "Front left tire low, sidewall cut", category: "tires", urgency: "immediate", safety_critical: true })])).rows[0].r.id as string };
  });
  await signIn(page, "mechanic");
  await page.goto("/maintenance/my-jobs");
  const needs = page.getByRole("list", { name: "Needs a mechanic" });
  const card = needs.getByRole("listitem").filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Reported");
  await expect(card).toContainText("Safety-critical");
  // Safety-critical jobs come before every other job in the list.
  const texts = await needs.getByRole("listitem").allTextContents();
  const firstPlain = texts.findIndex((t) => !t.includes("Safety-critical"));
  if (firstPlain >= 0) expect(texts.slice(firstPlain).some((t) => t.includes("Safety-critical"))).toBe(false);

  // One start rule (I1): Start work on the work order makes the mechanic the lead and starts the timer.
  await page.goto(`/maintenance/work-orders/${id}`);
  await page.getByRole("button", { name: "Start work" }).click();
  await expectToast(page, "Job started. You are the lead mechanic. Your timer is running.");
  await asUser(USERS.mechanic.email, async (q) => {
    const r = await q("select w.status, w.assigned_to = auth.uid() as lead, (select count(*)::int from public.work_order_time_entries e where e.work_order_id = w.id and e.user_id = auth.uid() and e.ended_at is null and e.voided_at is null) as running from public.work_orders w where w.id = $1", [id]);
    expect(r.rows[0]).toMatchObject({ status: "in_progress", lead: true, running: 1 });
  });
  // Leaving In progress stops the person's own timer first.
  await page.getByRole("button", { name: "Waiting for parts" }).first().click();
  await page.getByLabel("Which part is missing?").fill("Steer tire");
  await page.getByRole("button", { name: "Mark waiting for parts" }).click();
  await expectToast(page, /Your timer is stopped/);
});

test("people without maintenance access cannot open My jobs", async ({ page }) => {
  await signIn(page, "driver");
  const res = await page.goto("/maintenance/my-jobs");
  expect([200, 403, 404]).toContain(res?.status() ?? 0);
  await expect(page.getByRole("heading", { name: "Maintenance" })).toHaveCount(0);
});
