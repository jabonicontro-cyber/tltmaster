// First-day walkthrough fixes, batch 2 (dispatch and orders, 2026-11-14): what a new office person and dispatcher see.
//   D9  an order whose delivery location is a stop is scheduled from the order page; the date is pre-filled; an order
//       with no location is refused without saving the date; the badge says Scheduled at once (D4).
//   D3  the assign window gives no verdict before a truck and a driver are chosen.
//   D6  Smart Dispatch is one line on the board until opened; picking a period opens it.
//   D11 Plan the day shows estimated revenue only to people with billing access.
//   D1  a load with an open hired-truck offer is refused to the company's own crew (and Smart Dispatch holds it).
//   D2  an open offer whose hired truck is booked at the same time says so before "Confirm and assign".
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { asUser, realMaterial } from "./db";
import { expectToast, unique } from "./helpers";
import { totp } from "./mfa";
import { PASSWORD } from "./users";

const TOP_LINE = "00000000-0000-4000-8000-000000000001";
type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

// This spec's own sign-ins (not the shared e2e users, whose sessions other runs reset), created like global-setup does:
// a membership in Top Line, and for owner and office (money access) a fresh authenticator each run.
const OWN = {
  owner: { email: "e2e-wk2-owner@toplinetest.example", name: "Wren Owner (e2e)", role: "owner" },
  office: { email: "e2e-wk2-office@toplinetest.example", name: "Odell Office (e2e)", role: "office" },
  dispatcher: { email: "e2e-wk2-dispatch@toplinetest.example", name: "Dale Dispatch (e2e)", role: "dispatcher" },
} as const;
type Who = keyof typeof OWN;
const secrets: Partial<Record<Who, string>> = {};

test.beforeAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const [who, u] of Object.entries(OWN) as Array<[Who, (typeof OWN)[Who]]>) {
    const { data: existing } = await admin.from("profiles").select("id").eq("email", u.email).maybeSingle();
    let id = existing?.id as string | undefined;
    if (!id) {
      const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: u.name } });
      if (error) throw new Error(`createUser ${u.email}: ${error.message}`);
      id = data.user.id;
    }
    await admin.from("profiles").update({ full_name: u.name }).eq("id", id);
    const { error: mErr } = await admin.from("company_memberships").upsert({ company_id: TOP_LINE, user_id: id, role: u.role, active: true }, { onConflict: "company_id,user_id" });
    if (mErr) throw new Error(`membership ${u.email}: ${mErr.message}`);
    if (who === "dispatcher") continue;
    const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId: id });
    for (const f of factors?.factors ?? []) await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: id });
    const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: inErr } = await client.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    if (inErr) throw new Error(`${u.email}: ${inErr.message}`);
    const { data: f, error: fErr } = await client.auth.mfa.enroll({ factorType: "totp", friendlyName: "e2e" });
    if (fErr || !f) throw new Error(`MFA enroll ${u.email}: ${fErr?.message}`);
    const { error: vErr } = await client.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(f.totp.secret) });
    if (vErr) throw new Error(`MFA verify ${u.email}: ${vErr.message}`);
    await client.rpc("mfa_recovery_generate");
    await client.rpc("mfa_recovery_confirm");
    secrets[who] = f.totp.secret;
  }
});

async function signIn(page: Page, who: Who) {
  await page.goto("/login");
  await page.getByLabel(/^Email/).fill(OWN[who].email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  if (secrets[who]) {
    await page.waitForURL((u) => u.pathname === "/mfa");
    await page.getByLabel("6-digit code").fill(totp(secrets[who]!));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.waitForURL((u) => u.pathname !== "/mfa");
  }
}
const USERS = OWN;

async function admin<T>(fn: (c: pg.Client) => Promise<T>) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const dayFrom = async (q: Q, plus: number) =>
  (await q(`select ((now() at time zone coalesce((select timezone from public.company_settings limit 1), 'America/Chicago'))::date + ${plus})::text as d`)).rows[0].d as string;

/** A confirmed direct order with no job site (only a state, as the walkthrough's), optionally with stops. */
async function confirmedOrder(q: Q, id: string, requested: string, stops: boolean) {
  const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
  const mat = await realMaterial(q);
  const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
    customer_id: cust.rows[0].id, project_name: `Walkthrough e2e ${id}`, site_state: "IN", requested_date: requested,
    lines: [{ kind: "material", calc_method: "per_unit", material_id: mat.id, description: "Base (e2e)", unit_code: mat.unit, quantity: "10", unit_rate_cents: 1000 }],
  })]);
  const o = r.rows[0].r as { order_id: string; order_number: string };
  if (stops) {
    await q("select public.save_order_stops($1, $2::jsonb)", [o.order_id, JSON.stringify([
      { kind: "pickup", name: `Acme Steel ${id} (test)`, city: "Gary", state: "IN" },
      { kind: "delivery", name: `Willowmere Works ${id} (test)`, address_line1: "12 Mill Rd", city: "Goshen", state: "IN" },
    ])]);
  }
  await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
  return o;
}

/** A scheduled order (job site "(test)") with one open load on `day` from `start` to `end`. */
async function openLoad(q: Q, id: string, day: string, start: string, end: string) {
  const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
  const mat = await realMaterial(q);
  const r = await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
    site_line1: "100 Test Site Rd (test)", customer_id: cust.rows[0].id, project_name: `Walkthrough e2e ${id}`,
    lines: [{ kind: "material", calc_method: "per_unit", material_id: mat.id, description: "Base (e2e)", unit_code: mat.unit, quantity: "22", unit_rate_cents: 1000 }],
  })]);
  const o = r.rows[0].r as { order_id: string; order_number: string };
  await q("select public.set_order_status($1, 'confirmed', '')", [o.order_id]);
  await q("select public.update_order_schedule($1, null, $2::jsonb)", [o.order_id, JSON.stringify({ scheduled_start: day, scheduled_end: day })]);
  await q("select public.set_order_status($1, 'scheduled', '')", [o.order_id]);
  const l = (await q("select public.save_order_load($1::jsonb) as r", [JSON.stringify({ order_id: o.order_id, load_date: day, start_time: start, end_time: end, planned_quantity: "10", unit_code: mat.unit })])).rows[0].r as { load_id: string };
  return { orderId: o.order_id, orderNumber: o.order_number, loadId: l.load_id };
}

test("D9 and D4: an order with a delivery stop is scheduled from the order page; one with no location saves nothing", async ({ page }) => {
  const id = unique();
  // Created by the owner (the sample rate differs from the price list); the office schedules it in the browser.
  const { withStops, bare, requested } = await asUser(USERS.owner.email, async (q) => {
    const requested = await dayFrom(q, 3);
    return { requested, withStops: await confirmedOrder(q, id, requested, true), bare: await confirmedOrder(q, `${id}b`, requested, false) };
  });
  await signIn(page, "office");

  await page.goto(`/orders/${withStops.order_id}`);
  // The job site is the last delivery stop, not the lone default state ("Delivery location: IN").
  await expect(page.getByText(`Last delivery stop: Willowmere Works ${id} (test)`)).toBeVisible();
  await page.getByRole("button", { name: "Mark scheduled" }).click();
  const dialog = page.getByRole("dialog");
  // The requested date is filled in already.
  await expect(dialog.getByLabel("Delivery date")).toHaveValue(requested);
  await dialog.getByRole("button", { name: /^Save and mark scheduled/ }).click();
  await expectToast(page, "Schedule saved. Order marked scheduled.");
  // The header shows the new status without a reload (D4).
  const badges = page.getByRole("heading", { level: 1 }).locator("xpath=..");
  await expect(badges.getByText("Scheduled", { exact: true })).toBeVisible();
  await expect(badges.getByText("Confirmed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark scheduled" })).toHaveCount(0);
  expect((await admin((c) => c.query("select status from public.orders where id = $1", [withStops.order_id]))).rows[0].status).toBe("scheduled");

  // No site, no stop: refused in the window, and the date is not saved.
  await page.goto(`/orders/${bare.order_id}`);
  await page.getByRole("button", { name: "Mark scheduled" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Save and mark scheduled/ }).click();
  await expect(page.getByRole("dialog").getByText(/Add the delivery location to order .* or a delivery stop\. Nothing was saved\./)).toBeVisible();
  const row = (await admin((c) => c.query("select status, scheduled_start from public.orders where id = $1", [bare.order_id]))).rows[0];
  expect(row).toEqual({ status: "confirmed", scheduled_start: null });

  // D4: confirming a draft shows Confirmed in the header at once (the walkthrough saw "Draft" until a reload).
  const draft = await asUser(USERS.owner.email, async (q) => {
    const cust = await q("select id from public.customers where name = 'Prairie View Landscaping' and company_id = $1", [TOP_LINE]);
    const mat = await realMaterial(q);
    return (await q("select public.save_order_draft($1::jsonb) as r", [JSON.stringify({
      customer_id: cust.rows[0].id, project_name: `Walkthrough e2e ${id}c`, site_line1: "100 Test Site Rd (test)",
      lines: [{ kind: "material", calc_method: "per_unit", material_id: mat.id, description: "Base (e2e)", unit_code: mat.unit, quantity: "10", unit_rate_cents: 1000 }],
    })])).rows[0].r as { order_id: string };
  });
  await page.goto(`/orders/${draft.order_id}`);
  await expect(badges.getByText("Draft", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm order" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm order" }).click();
  await expectToast(page, "Order marked confirmed.");
  await expect(badges.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(badges.getByText("Draft", { exact: true })).toHaveCount(0);
});

test("D3, D6, D11: the assign window waits for a truck and driver; Smart Dispatch is one line; revenue needs billing access", async ({ page, browser }) => {
  const id = unique();
  const f = await asUser(USERS.owner.email, async (q) => {
    const day = await dayFrom(q, 2);
    return { day, ...(await openLoad(q, id, day, "13:00", "14:00")) };
  });
  await signIn(page, "dispatcher");

  // D6: the board opens on the day's work; Smart Dispatch is folded to its summary line.
  await page.goto("/dispatch");
  const smart = page.locator('details[aria-label="Smart Dispatch"]');
  await expect(smart).toBeVisible();
  await expect(smart).not.toHaveAttribute("open", /.*/);
  // Picking a period opens it.
  await page.goto("/dispatch?horizon=3");
  await expect(smart).toHaveAttribute("open", /.*/);

  // D3: no verdict before both are chosen.
  await page.goto(`/dispatch?date=${f.day}&load=${f.loadId}`);
  const card = page.locator("section").filter({ has: page.getByRole("link", { name: f.orderNumber, exact: true }) });
  await card.getByRole("listitem", { name: "Load 1", exact: true }).getByRole("button", { name: "Assign", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("This combination can be assigned.", { exact: true })).toHaveCount(0);
  const truck = dialog.getByLabel("Truck");
  const firstTruck = await truck.locator("optgroup").first().locator("option").first().getAttribute("value");
  await truck.selectOption(firstTruck!);
  await expect(dialog.getByText("Choose a driver to see whether this combination can be assigned.")).toBeVisible();
  await expect(dialog.getByText("This combination can be assigned.", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // D11: the dispatcher (no billing access) sees no revenue on Plan the day.
  await page.goto(`/dispatch/plan?date=${f.day}`);
  await expect(page.getByText("Loads covered")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Estimated revenue")).toHaveCount(0);
  await expect(page.getByText(/estimated revenue|est\.$/)).toHaveCount(0);
  await expect(page.getByText("Revenue is not part of this plan: it is shown to people with billing access.")).toBeAttached();

  // The owner (billing access) still sees it.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signIn(owner, "owner");
  await owner.goto(`/dispatch/plan?date=${f.day}`);
  await expect(owner.getByText("Estimated revenue", { exact: true })).toBeVisible({ timeout: 60_000 });
  await ownerContext.close();
});

test.describe("hired trucks", () => {
  test.afterAll(async () => {
    await admin((c) => c.query("delete from private.hired_trucks_entitlements where company_id = $1", [TOP_LINE]));
  });

  test("D1 and D2: an open offer holds its load, and a clash is named before confirming", async ({ page }) => {
    const id = unique();
    await admin((c) => c.query("insert into private.hired_trucks_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [TOP_LINE]));
    const f = await asUser(USERS.owner.email, async (q) => {
      const day = await dayFrom(q, 4);
      const far = await dayFrom(q, 300);
      const h = (await q("select public.hauler_save(null, $1, 'Pat', '555-0100', '', '', true) as r", [`Ridgeline ${id} (test)`])).rows[0].r as string;
      const truck = (await q("select public.hauler_add_truck($1, $2, 'tri_axle_dump', 'HT1') as r", [h, `H-${id}`])).rows[0].r as string;
      const driver = (await q("select public.hauler_add_driver($1, $2, '555-0101') as r", [h, `Casey ${id}`])).rows[0].r as string;
      for (const [kind, t, exp] of [["insurance", null, far], ["w9", null, null], ["agreement", null, null], ["registration", truck, far], ["inspection", truck, far]] as const) {
        await q("select public.hauler_record_document($1, $2, $3, 'ref', $4)", [h, t, kind, exp]);
      }
      for (const kind of ["cdl", "medical_card"]) await q("insert into public.driver_qualifications (driver_id, kind, cdl_class, expires_on, verified_at) values ($1, $2, $3, $4, now())", [driver, kind, kind === "cdl" ? "A" : null, far]);
      // As the demo sample used to: an offer on load A, then load B (overlapping) offered, accepted and confirmed.
      const a = await openLoad(q, `${id}a`, day, "07:00", "08:30");
      const b = await openLoad(q, `${id}b`, day, "07:30", "09:00");
      const offerA = (await q("select public.hauler_offer_send($1, $2, null, $3, 9000, 'load', '') as r", [a.loadId, truck, driver])).rows[0].r as string;
      const offerB = (await q("select public.hauler_offer_send($1, $2, null, $3, 9000, 'load', '') as r", [b.loadId, truck, driver])).rows[0].r as string;
      await q("select public.hauler_offer_respond($1, true, 'By phone')", [offerB]);
      await q("select public.hauler_offer_confirm($1)", [offerB]);
      await q("select public.hauler_offer_respond($1, true, 'By phone')", [offerA]);
      const own = (await q("select id from public.trucks where hauler_id is null and active and service_status = 'in_service' order by unit_number limit 1")).rows[0].id as string;
      const ownDriver = (await q("select id from public.drivers where hauler_id is null and active order by name limit 1")).rows[0].id as string;
      return { day, a, b, unit: `H-${id}`, own, ownDriver };
    });

    // D2: the clash is said on the open offer, with the day of the other booking.
    await signIn(page, "dispatcher");
    await page.goto("/hired-trucks");
    const offer = page.getByRole("listitem", { name: `Offer for ${f.a.orderNumber} load 1` });
    await expect(offer.getByRole("note")).toContainText(`This hired truck is already on ${f.b.orderNumber} load 1 on`);
    await expect(offer.getByRole("note")).toContainText("7:30 AM to 9:00 AM. Confirming will be refused");
    await expect(offer.getByRole("button", { name: "Confirm and assign" })).toBeVisible();

    // D1: the accepted offer holds load A; the own crew is refused with the next step (database, any path).
    const refused = await asUser(USERS.dispatcher.email, (q) => q("select public.assign_load($1, $2, null, $3, '', null)", [f.a.loadId, f.own, f.ownDriver]).then(() => "assigned", (e: Error) => e.message));
    expect(refused).toMatch(new RegExp(`${f.a.orderNumber} load 1 is offered to a hired truck \\(Ridgeline ${id} \\(test\\)\\)\\. Withdraw the offer in Hired trucks`));

    // Smart Dispatch does not propose the own crew for it; it says why.
    await page.goto(`/dispatch?date=${f.day}&horizon=7`);
    const smart = page.locator('details[aria-label="Smart Dispatch"]');
    await expect(smart.locator("summary").first()).toContainText(/unassigned load/);
    // Six loads are shown first; load A (four days out) is often further down. "Show all" is a client toggle: a click
    // that lands before the page is interactive does nothing, so it is clicked until the full list is open.
    const all = smart.getByRole("button", { name: /^Show all \d+ loads$/ });
    if (await all.count()) {
      await expect(async () => {
        if (await all.count()) await all.click();
        await expect(smart.getByRole("button", { name: "Show fewer" })).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 20_000 });
    }
    await expect(smart.getByRole("listitem", { name: `${f.a.orderNumber} load 1` })).toContainText("A hired truck accepted this load.");
  });
});
