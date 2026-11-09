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

  // Starting the timer puts the mechanic on the crew as working; a second start elsewhere is not offered.
  await page.getByRole("button", { name: "Start timer" }).click();
  await expectToast(page, "Timer started.");
  await expect(page.getByText(/Working · 0 h/)).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expectToast(page, "Timer stopped.");

  // Add the owner's time after the fact (owners can do maintenance in the default roles) and refuse an overlap.
  await page.getByLabel("Add a mechanic").selectOption({ label: USERS.owner.name });
  await page.getByRole("button", { name: "Add to crew" }).click();
  await expectToast(page, "Mechanic added.");
  // A past day (a different one each run, so repeated runs never overlap), in the company's time zone.
  const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(Date.now() - (2 + Math.floor(Math.random() * 300)) * 86400000));
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

  // Checklist (its own tab; the work order opens on Labor while in progress).
  await page.getByRole("navigation", { name: "Work order sections" }).getByRole("link", { name: /^Checklist/ }).click();
  await page.getByLabel("New task").fill("Cage the spring brake");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expectToast(page, "Task added.");
  await page.getByRole("button", { name: 'Mark "Cage the spring brake" done' }).click();
  await expectToast(page, "Task updated.");
  await expect(page.getByText("1 of 1 done")).toBeVisible();

  // The history records it all.
  await page.getByRole("navigation", { name: "Work order sections" }).getByRole("link", { name: /^Activity/ }).click();
  await expect(page.getByText("Labor time").first()).toBeVisible();
  await expect(page.getByText("Task added: Cage the spring brake")).toBeVisible();

  // The only mechanic finishes the job in one step (first-day review 2026-11-09): what was fixed goes into Findings and
  // a job that is not safety-critical is completed.
  await page.goto(`/maintenance/work-orders/${id}?tab=labor`);
  await page.getByRole("button", { name: "Finish the job" }).click();
  await page.getByLabel("What did you fix?").fill("Adjusted the slack adjusters");
  await page.getByRole("button", { name: "Mark completed" }).click();
  await expectToast(page, "Job completed.");
  await expect(page.locator("p", { hasText: "Findings:" })).toContainText("Adjusted the slack adjusters");
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
  await page.goto(`/maintenance/work-orders/${id}?tab=labor`);
  await page.getByLabel("Estimated hours").fill("3.5");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expectToast(page, "Estimate saved.");
  await page.reload();
  await expect(page.getByLabel("Estimated hours")).toHaveValue("3.5");
});

test("triage: rules suggest, quote the report and ask questions; a person edits, and the safety flag is added", async ({ page }) => {
  const { id } = await asUser(USERS.mechanic.email, async (q) => {
    const truck = (await q("select id from public.trucks where active and service_status = 'in_service' order by unit_number desc limit 1")).rows[0].id as string;
    // Led by the mechanic, so these test jobs do not pile up under "Needs a mechanic" run after run.
    return { id: (await q("select public.maintenance_create_work_order($1::jsonb || jsonb_build_object('assigned_to', auth.uid())) r", [JSON.stringify({ truck_id: truck, title: `Air leak ${unique()}`, description: "Hissing near the rear brake chamber since this morning. It is getting worse.", category: "repair" })])).rows[0].r.id as string };
  });
  await signIn(page, "mechanic");
  await page.goto(`/maintenance/work-orders/${id}`);
  await page.getByRole("button", { name: "Suggest what to check" }).click();
  await expectToast(page, "Suggestion ready.");
  await expect(page.getByText("Suggested by rules", { exact: true })).toBeVisible();
  await expect(page.getByText("“Hissing near the rear brake chamber since this morning.”")).toBeVisible();
  await expect(page.getByText(/Safety review recommended/)).toBeVisible();
  await expect(page.getByText("What does the air pressure gauge show, and does it drop when the brakes are applied?")).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const form = page.getByRole("form", { name: "Edit suggestion" });
  await form.getByLabel("Urgency").selectOption("immediate");
  await form.getByRole("button", { name: "Apply my changes" }).click();
  await expectToast(page, "Your changes were applied.");
  await expect(page.getByText("Accepted with changes")).toBeVisible();
  // The work order now carries the decision: brakes, immediate, safety-critical (the truck is restricted).
  await expect(page.getByText("Immediate").first()).toBeVisible();
  await expect(page.getByText("Safety-critical").first()).toBeVisible();
  await expect(page.getByText(/restricted/i).first()).toBeVisible();
});

// Safety (B3): a suggestion never lowers a job's urgency or removes the safety flag. Here the saved suggestion says
// Normal and not safety-critical (as an older suggestion would, or one made before the urgency was raised); accepting
// asks first, shows what changes, and the job stays Immediate and safety-critical.
test("triage: accepting a suggestion on an Immediate safety-critical job keeps it Immediate", async ({ page }) => {
  const title = `Sidewall ${unique()}`;
  const { id } = await asUser(USERS.owner.email, async (q) => {
    const truck = (await q("insert into public.trucks (unit_number, truck_type) values ($1, 'tri_axle_dump') returning id", [`ZTR-${unique()}`.slice(0, 20)])).rows[0].id as string;
    // Led by the owner, so these test jobs do not pile up under "Needs a mechanic" run after run.
    const wo = (await q("select public.maintenance_create_work_order($1::jsonb || jsonb_build_object('assigned_to', auth.uid())) r", [JSON.stringify({ truck_id: truck, title, description: "tires: Front left tire low, sidewall cut", category: "repair", urgency: "immediate", safety_critical: true })])).rows[0].r.id as string;
    const stale = { version: 1, problem: title, facts: ["tires: Front left tire low, sidewall cut"], symptoms: [], onset: null, worsening: "unknown", questions: [], category: "tires", urgency: "normal", safetyReview: false, reasons: ["Mentions tires."], related: [] };
    await q("select public.maintenance_save_triage($1, 'rules', '', $2::jsonb)", [wo, JSON.stringify(stale)]);
    return { id: wo };
  });
  await signIn(page, "mechanic");
  await page.goto(`/maintenance/work-orders/${id}?tab=triage`);
  await expect(page.getByText("The work order is already Immediate: accepting keeps Immediate.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  const confirm = page.getByRole("region", { name: "Accept the suggestion?" });
  await expect(confirm).toContainText("Category: Repair → Tires");
  await expect(confirm).toContainText("Urgency stays Immediate (the suggestion said Normal; the higher one is kept).");
  await expect(confirm).toContainText("It stays safety-critical");
  await confirm.getByRole("button", { name: "Yes, accept" }).click();
  await expectToast(page, "Suggestion accepted. The urgency stays Immediate");
  await asUser(USERS.owner.email, async (q) => {
    const r = await q("select category, urgency, safety_critical from public.work_orders where id = $1", [id]);
    expect(r.rows[0]).toMatchObject({ category: "tires", urgency: "immediate", safety_critical: true });
  });
  // A new suggestion starts from the work order: Immediate, and the tire damage reads as safety-critical.
  await page.getByRole("button", { name: "Suggest again" }).click();
  await expectToast(page, "Suggestion ready.");
  await expect(page.getByRole("region", { name: "Suggestion" })).toContainText("Tires · Immediate urgency");
});

// B91: estimates that learn from recorded labor; estimate against actual for people with cost access only.
test("time estimates: owners see estimate against actual, mechanics do not get the page", async ({ page, browser }) => {
  await signIn(page, "owner");
  await page.goto("/maintenance/estimates");
  await expect(page.getByRole("navigation", { name: "Maintenance sections" }).getByRole("link", { name: "Time estimates" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("What each kind of job takes")).toBeVisible();
  await expect(page.getByText("Estimate against actual by mechanic")).toBeVisible();
  await expect(page.getByText(/nothing comes from AI/)).toBeVisible();

  const mech = await browser.newPage();
  await signIn(mech, "mechanic");
  await mech.goto("/maintenance");
  await expect(mech.getByRole("navigation", { name: "Maintenance sections" }).getByRole("link", { name: "Time estimates" })).toHaveCount(0);
  await mech.goto("/maintenance/estimates");
  await mech.waitForURL(/no-access/);
  await mech.close();
});
