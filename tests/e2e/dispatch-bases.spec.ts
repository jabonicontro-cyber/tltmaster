import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { asUser } from "./db";
import { signIn, unique } from "./helpers";
import { OTHER_COMPANY, PASSWORD, TOP_LINE_SLUG, USERS } from "./users";

// Settings → Dispatch Bases (migrations 20261120000100/000200): the plan limit shows and is enforced, a base can be
// added, edited, made default and deactivated without touching its records, and a person can be limited to a base.

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

test("a one-base plan shows its base and the limit; dispatch reads it without edit controls", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/settings?tab=bases");
  await expect(page.getByRole("heading", { name: "Dispatch Bases" })).toBeVisible();
  const table = page.getByRole("table", { name: "Dispatch bases" });
  await expect(table.getByRole("row").filter({ hasText: "MAIN" })).toContainText("Default");
  await expect(page.getByLabel("Plan allowance")).toHaveText(/1 of 1 active base included/);
  await expect(page.getByText("Base limit reached")).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "dispatcher");
  await page.goto("/settings?tab=bases");
  await expect(page.getByRole("table", { name: "Dispatch bases" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  await expect(page.getByText("Add a Base")).toHaveCount(0);
});

test("on a two-base plan the owner adds, edits, makes default and deactivates a base; a third is refused by the database", async ({ page }) => {
  test.slow();
  const companyId = await admin(async (c) => {
    const id = (await c.query<{ id: string }>("select id from public.companies where slug = $1", [OTHER_COMPANY.slug])).rows[0].id;
    const v = (await c.query<{ id: string }>("select id from private.platform_plan_versions where plan_key = 'growth' order by version desc limit 1")).rows[0].id;
    await c.query("insert into private.company_lifecycle (company_id, plan_version_id) values ($1, $2) on conflict (company_id) do update set plan_version_id = excluded.plan_version_id", [id, v]);
    // A clean start: only the default base active.
    await c.query("update public.dispatch_bases set active = false where company_id = $1 and not is_default", [id]);
    return id;
  });
  const code = `N${unique().toUpperCase().slice(0, 5)}`;
  try {
    await signIn(page, "otherOwner");
    await page.goto("/settings?tab=bases");
    await expect(page.getByLabel("Plan allowance")).toHaveText(/1 of 2 active bases/);
    await page.getByText("Add a Base").click();
    await page.getByLabel("Name").last().fill(`North Yard ${code}`);
    await page.getByLabel("Code").last().fill(code);
    await page.getByLabel("City").last().fill("Fargo");
    await page.getByRole("button", { name: "Add Base" }).click();
    await expect(page.getByText("Base added.")).toBeVisible();
    const row = page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: code });
    await expect(row).toContainText("Fargo");
    await expect(page.getByText("Base limit reached")).toBeVisible();

    // A third base is refused by the database too, not only hidden in the page.
    const refused = await admin((c) => c.query("insert into public.dispatch_bases (company_id, code, name) values ($1, 'THIRD', 'Third')", [companyId]).then(() => null, (e: { code: string }) => e.code));
    expect(refused).toBe("P0001");

    // Edit, make default, then deactivate is refused for the default; switch back and deactivate.
    await row.getByText("Edit").click();
    await row.getByLabel("Contact", { exact: true }).fill("Nia North");
    await row.getByRole("button", { name: "Save Base" }).click();
    await expect(page.getByText("Base saved.")).toBeVisible();
    await page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: code }).getByRole("button", { name: "Make Default" }).click();
    await expect(page.getByText(/Default base changed/)).toBeVisible();
    await expect(page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: code })).toContainText("Default");
    await page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: "MAIN" }).getByRole("button", { name: "Make Default" }).click();
    await expect(page.getByText(/Default base changed/)).toBeVisible();

    // Fleet: the truck form offers the base, and the list filters by it.
    const northId = await admin(async (c) => (await c.query<{ id: string }>("select id from public.dispatch_bases where company_id = $1 and code = $2", [companyId, code])).rows[0].id);
    const mainId = await admin(async (c) => (await c.query<{ id: string }>("select id from public.dispatch_bases where company_id = $1 and code = 'MAIN'", [companyId])).rows[0].id);
    await page.goto("/fleet/trucks/new");
    await page.getByLabel("Unit number").fill(`T-${code}`);
    await page.getByRole("combobox", { name: "Type", exact: true }).selectOption({ index: 1 });
    await page.getByLabel("Dispatch base").selectOption(northId);
    await page.getByRole("button", { name: "Add truck" }).click();
    await expect(page).toHaveURL(/\/fleet\/trucks\/[0-9a-f-]{36}(\?saved=1)?$/);
    await page.goto(`/fleet/trucks?base=${northId}`);
    await expect(page.getByRole("row").filter({ hasText: `T-${code}` })).toBeVisible();
    await page.goto(`/fleet/trucks?base=${mainId}`);
    await expect(page.getByRole("row").filter({ hasText: `T-${code}` })).toHaveCount(0);

    // Base access: the section lists people (owners are never limited).
    // Orders: the order page shows its base and moves it (set_order_base, audited).
    const orderId = await admin(async (c) => {
      const cust = (await c.query<{ id: string }>("insert into public.customers (company_id, customer_number, name) values ($1, $2, 'Base Test Customer') returning id", [companyId, `BT-${code}`])).rows[0].id;
      return (await c.query<{ id: string }>("insert into public.orders (company_id, customer_id, order_number, order_date, base_id) values ($1, $2, $3, current_date, $4) returning id", [companyId, cust, `BO-${code}`, mainId])).rows[0].id;
    });
    await page.goto(`/orders/${orderId}`);
    await page.getByLabel("Dispatch base").selectOption(northId);
    await page.getByRole("button", { name: "Change Base" }).click();
    await expect(page.getByText("Dispatch base changed.")).toBeVisible();
    expect(await admin(async (c) => (await c.query("select base_id from public.orders where id = $1", [orderId])).rows[0].base_id)).toBe(northId);
    await page.goto(`/orders?base=${northId}`);
    await expect(page.getByRole("link", { name: `BO-${code}` })).toBeVisible();

    // Dispatch board: the base filter keeps the chosen base across days.
    await page.goto(`/dispatch?base=${northId}`);
    await expect(page.getByLabel("Dispatch base")).toHaveValue(northId);
    await expect(page.getByRole("link", { name: /^Next/ })).toHaveAttribute("href", new RegExp(`base=${northId}`));
    await page.getByLabel("Dispatch base").selectOption("");
    await page.getByRole("button", { name: "Go" }).click();
    await expect(page).not.toHaveURL(/base=[0-9a-f]/);

    // Work orders: a North truck's work order is listed under North, not under Main.
    const woNumber = await asUser(USERS.otherOwner.email, async (q) => {
      const truck = (await q("select id from public.trucks where unit_number = $1", [`T-${code}`])).rows[0].id as string;
      return (await q("select public.maintenance_create_work_order($1::jsonb) as r", [JSON.stringify({ truck_id: truck, title: `Base filter ${code}`, category: "brakes", urgency: "normal" })])).rows[0].r.number as string;
    });
    await page.goto(`/maintenance/work-orders?base=${northId}`);
    await expect(page.getByLabel("Base")).toHaveValue(northId);
    await expect(page.getByRole("link", { name: woNumber })).toBeVisible();
    await page.goto(`/maintenance/work-orders?base=${mainId}`);
    await expect(page.getByRole("link", { name: woNumber })).toHaveCount(0);

    // Reports: a per-base section whose rows add up to the "All bases" row.
    await page.goto("/reports");
    await expect(page.getByRole("table", { name: "Dispatch base report" })).toContainText("All bases");

    // Cross-base dispatch: off by default, switched on and off again.
    await page.goto("/settings?tab=bases");
    await expect(page.getByText(/Off: Smart Dispatch proposes only/)).toBeVisible();
    await page.getByLabel("Allow trucks and drivers from other bases").check();
    await page.getByRole("region", { name: "Cross-Base Dispatch" }).getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Cross-base dispatch is on/).first()).toBeVisible();
    await page.getByLabel("Allow trucks and drivers from other bases").uncheck();
    await page.getByRole("region", { name: "Cross-Base Dispatch" }).getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/Cross-base dispatch is off/).first()).toBeVisible();

    await page.goto("/settings?tab=bases");
    // (This company may have nobody but its owner: then the page says how to add people instead of an empty table.)
    const access = page.getByRole("table", { name: "Base access" });
    await expect(access.or(page.getByText(/Once you add people on the People page/))).toBeVisible();
    if (await access.count()) await expect(access).not.toContainText(USERS.otherOwner.name);

    await page.getByRole("table", { name: "Dispatch bases" }).getByRole("row").filter({ hasText: code }).getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText(/Base deactivated/)).toBeVisible();
    await expect(page.getByLabel("Plan allowance")).toHaveText(/1 of 2 active bases/);
  } finally {
    await admin(async (c) => {
      await c.query("update public.dispatch_bases set is_default = false where company_id = $1 and code <> 'MAIN' and is_default", [companyId]);
      await c.query("update public.dispatch_bases set is_default = true where company_id = $1 and code = 'MAIN'", [companyId]);
      await c.query("update public.dispatch_bases set active = false where company_id = $1 and code <> 'MAIN'", [companyId]);
      await c.query("delete from private.company_lifecycle where company_id = $1", [companyId]);
      // Remove what this test created (Brookside must stay empty for the tenancy and Command Center tests). Order
      // records are append-only for users, so the cleanup bypasses those guards for its own rows only.
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query("delete from public.order_status_events where order_id in (select id from public.orders where company_id = $1 and order_number = $2)", [companyId, `BO-${code}`]);
      await c.query("delete from public.orders where company_id = $1 and order_number = $2", [companyId, `BO-${code}`]);
      await c.query("delete from public.customers where company_id = $1 and customer_number = $2", [companyId, `BT-${code}`]);
      await c.query("delete from public.work_order_events where work_order_id in (select id from public.work_orders where company_id = $1 and title = $2)", [companyId, `Base filter ${code}`]);
      await c.query("delete from public.work_orders where company_id = $1 and title = $2", [companyId, `Base filter ${code}`]);
      await c.query("delete from public.trucks where company_id = $1 and unit_number = $2", [companyId, `T-${code}`]);
      await c.query("commit");
    });
  }
});

test("a dispatcher limited to one base sees and changes only that base, in the pages and through the API", async ({ page }) => {
  test.slow();
  const code = `R${unique().toUpperCase().slice(0, 5)}`;
  const setup = await admin(async (c) => {
    const company = (await c.query<{ id: string }>("select id from public.companies where slug = $1", [TOP_LINE_SLUG])).rows[0].id;
    const before = (await c.query<{ plan_version_id: string }>("select plan_version_id from private.company_lifecycle where company_id = $1", [company])).rows[0]?.plan_version_id ?? null;
    const v = (await c.query<{ id: string }>("select id from private.platform_plan_versions where plan_key = 'growth' order by version desc limit 1")).rows[0].id;
    await c.query("insert into private.company_lifecycle (company_id, plan_version_id) values ($1, $2) on conflict (company_id) do update set plan_version_id = excluded.plan_version_id", [company, v]);
    await c.query("update public.dispatch_bases set active = false where company_id = $1 and not is_default", [company]);
    const north = (await c.query<{ id: string }>("insert into public.dispatch_bases (company_id, code, name, timezone) values ($1, $2, $3, 'America/Chicago') returning id", [company, code, `North ${code}`])).rows[0].id;
    const mainTruck = (await c.query<{ id: string; unit_number: string }>("select t.id, t.unit_number from public.trucks t join public.dispatch_bases b on b.id = t.base_id and b.is_default where t.company_id = $1 and t.active limit 1", [company])).rows[0];
    const mainOrder = (await c.query<{ id: string; order_number: string }>("select o.id, o.order_number from public.orders o join public.dispatch_bases b on b.id = o.base_id and b.is_default where o.company_id = $1 limit 1", [company])).rows[0];
    const dispatcher = (await c.query<{ id: string }>("select id from public.profiles where email = $1", [USERS.dispatcher.email])).rows[0].id;
    return { company, before, north, mainTruck, mainOrder, dispatcher };
  });
  try {
    // The owner limits the dispatcher to North (the app's function, audited); North gets a truck of its own.
    await asUser(USERS.owner.email, (q) => q("select public.set_person_bases($1, $2::uuid[])", [setup.dispatcher, [setup.north]]));
    const northTruck = await asUser(USERS.owner.email, async (q) =>
      (await q("insert into public.trucks (unit_number, truck_type, base_id) values ($1, 'tri_axle_dump', $2) returning id", [`T-${code}`, setup.north])).rows[0].id as string);

    // Pages: their base's truck opens; another base's truck and order are not found.
    await signIn(page, "dispatcher");
    await page.goto(`/fleet/trucks/${northTruck}`);
    await expect(page.getByRole("heading", { name: new RegExp(`T-${code}`) }).first()).toBeVisible();
    await page.goto(`/fleet/trucks/${setup.mainTruck.id}`);
    await expect(page.getByText("Not found", { exact: true })).toBeVisible();
    await page.goto(`/orders/${setup.mainOrder.id}`);
    await expect(page.getByText("Not found", { exact: true })).toBeVisible();
    await page.goto("/fleet/trucks");
    await expect(page.getByRole("row").filter({ hasText: `T-${code}` })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: setup.mainTruck.unit_number })).toHaveCount(0);

    // The API (PostgREST, signed in as the dispatcher): reads, direct writes and functions stop at the base.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const api = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: signInError } = await api.auth.signInWithPassword({ email: USERS.dispatcher.email, password: PASSWORD });
    expect(signInError).toBeNull();
    expect((await api.from("trucks").select("id").eq("id", northTruck)).data).toHaveLength(1);
    expect((await api.from("trucks").select("id").eq("id", setup.mainTruck.id)).data).toEqual([]);
    expect((await api.from("orders").select("id").eq("id", setup.mainOrder.id)).data).toEqual([]);
    expect((await api.from("order_loads").select("id").eq("order_id", setup.mainOrder.id)).data).toEqual([]);
    const patched = await api.from("trucks").update({ notes: "Not mine" }).eq("id", setup.mainTruck.id).select("id");
    expect(patched.data ?? []).toEqual([]);
    const refused = await api.rpc("set_order_status", { p_order_id: setup.mainOrder.id, p_status: "in_progress", p_note: "", p_expected_edit_seq: null });
    expect(refused.error?.code).toBe("42501");
    expect(await admin(async (c) => (await c.query("select notes from public.trucks where id = $1", [setup.mainTruck.id])).rows[0].notes)).not.toBe("Not mine");
  } finally {
    await admin(async (c) => {
      await c.query("delete from public.base_members where company_id = $1 and user_id = $2", [setup.company, setup.dispatcher]);
      await c.query("delete from public.trucks where company_id = $1 and unit_number = $2", [setup.company, `T-${code}`]);
      await c.query("update public.dispatch_bases set active = false where id = $1", [setup.north]);
      if (setup.before) await c.query("update private.company_lifecycle set plan_version_id = $2 where company_id = $1", [setup.company, setup.before]);
      else await c.query("delete from private.company_lifecycle where company_id = $1", [setup.company]);
    });
  }
});
