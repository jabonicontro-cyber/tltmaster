// Platform console (PC1, migrations 20261120020100 to 20261120020700): who may read company health, usage and the
// timeline, the support inbox and its audited status changes, a staff member's own visits, console search, the
// filtered audit log, the security overview and lead demo dates; the Launchpad fixes; and that each rollback works.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const MIGRATIONS = ["20261120020100_lead_demo_date", "20261120020200_console_fixes", "20261120020300_company_health", "20261120020400_company_timeline_usage", "20261120020500_support_inbox", "20261120020600_console_search_audit", "20261120020700_security_overview"];
const migration = (n: string) => readFileSync(join(__dirname, `../../supabase/migrations/${n}.sql`), "utf8");
// A rollback without its own begin/commit (the test's transaction wraps it).
const rollback = (n: string) => readFileSync(join(__dirname, `../../supabase/rollbacks/${n}.down.sql`), "utf8").replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");

async function staff(s: Session, level: "admin" | "support" = "admin", displayName = "") {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  await s.query("update private.platform_admins set level = $2 where user_id = $1", [id, level]);
  if (displayName) await s.query("update public.profiles set display_name = $2 where id = $1", [id, displayName]);
  return id;
}

/** A company with an owner and a dispatcher; live (needs a grant) unless said otherwise. */
async function company(s: Session, opts: { live?: boolean; demo?: boolean } = {}) {
  const id = await s.createCompany(`Console Haul ${Math.random().toString(36).slice(2, 8)} (test)`);
  await s.asAdmin();
  if (opts.demo) await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [id]);
  if (opts.live) await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [id]);
  const owner = await s.createUser("owner", { companyId: id });
  const dispatcher = await s.createUser("dispatcher", { companyId: id });
  return { id, owner, dispatcher };
}

/** The company's owner lets Taviron support in (a company in use needs its owner's grant). */
async function allowSupport(s: Session, c: { owner: string }) {
  await s.as(c.owner);
  await s.query("select public.support_access_grant(3)");
}

const one = async <T>(s: Session, sql: string, params: unknown[] = []) => (await s.query<{ r: T }>(sql, params)).rows[0].r;

describe("company health, usage and timeline", () => {
  it("Admin and Support read counts; company people are refused; Taviron staff are never counted as active", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const sup = await staff(s, "support");
      const c = await company(s);
      await s.asAdmin();
      await s.query("update auth.users set last_sign_in_at = now() - interval '2 days' where id = $1", [c.dispatcher]);
      await s.query("update auth.users set last_sign_in_at = now() where id = $1", [sup]);
      await allowSupport(s, c);

      await s.as(sup);
      const rows = (await s.query("select * from public.platform_company_health($1)", [c.id])).rows;
      expect(rows).toHaveLength(1);
      // Active: the dispatcher signed in, and the owner changed something (gave support access).
      expect(rows[0]).toMatchObject({ company_id: c.id, members: 2, active_7d: 2, stage: "not_set_up", is_demo: false, loads_this_week: 0 });
      // Every active company without an id.
      const all = (await s.query<{ company_id: string }>("select company_id from public.platform_company_health()")).rows.map((r) => r.company_id);
      expect(all).toContain(c.id);
      expect((await s.query("select * from public.platform_company_usage($1, 4)", [c.id])).rows).toHaveLength(4);

      // A visit by support does not make the company "active", and is counted as a visit.
      await s.query("select public.platform_support_enter($1, 'Help with setup')", [c.id]);
      await s.query("select public.platform_support_leave()");
      const after = (await s.query("select * from public.platform_company_health($1)", [c.id])).rows[0];
      expect(after.active_7d).toBe(2);
      expect(after.support_visits_30d).toBe(1);

      // The timeline is Admin only and shows the visit with its reason (once, not twice).
      expect((await pgError(s.query("select public.platform_company_timeline($1)", [c.id]))).code).toBe("42501");
      await s.as(adm);
      const items = await one<Array<{ source: string; kind: string; summary: string }>>(s, "select public.platform_company_timeline($1) r", [c.id]);
      expect(items.filter((i) => i.source === "support" && i.kind === "visit_started")).toEqual([expect.objectContaining({ summary: "Help with setup" })]);
      expect(items.some((i) => i.kind === "support_entered")).toBe(false);
      expect((await pgError(s.query("select public.platform_company_timeline(gen_random_uuid())"))).code).toBe("P0002");

      for (const person of [c.owner, c.dispatcher]) {
        await s.as(person);
        expect((await pgError(s.query("select * from public.platform_company_health($1)", [c.id]))).code).toBe("42501");
        expect((await pgError(s.query("select * from public.platform_company_usage($1, 4)", [c.id]))).code).toBe("42501");
        expect((await pgError(s.query("select public.platform_company_timeline($1)", [c.id]))).code).toBe("42501");
      }
    });
  });

  it("marks demo companies, and counts loads in the company's own week", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const demo = await company(s, { demo: true });
      await s.as(adm);
      const h = (await s.query("select * from public.platform_company_health($1)", [demo.id])).rows[0];
      expect(h).toMatchObject({ is_demo: true, stage: "demo" });
      expect(new Date(h.week_start).getUTCDay()).toBe(1); // a Monday
    });
  });
});

describe("support inbox", () => {
  it("both staff levels read requests, change their status and add notes, all audited; company people cannot", async () => {
    await withSession(async (s) => {
      const sup = await staff(s, "support", "Sam S.");
      const c = await company(s, { live: true });
      await s.as(c.dispatcher);
      const req = await one<string>(s, "insert into public.help_support_requests (page, message) values ('/dispatch', 'The board does not show my trucks today.') returning id r");

      await s.as(sup);
      const inbox = await one<{ items: Array<{ id: string; status: string; from_email: string; company_id: string }> }>(s, "select public.platform_support_inbox('open') r");
      expect(inbox.items.find((i) => i.id === req)).toMatchObject({ status: "new", company_id: c.id });
      expect((await pgError(s.query("select public.platform_support_inbox('bogus')"))).code).toBe("22023");
      expect((await pgError(s.query("select public.platform_support_request_update($1, null, 'note', '  ')", [req]))).code).toBe("22023");
      expect((await pgError(s.query("select public.platform_support_request_update($1, 'done', 'note', '')", [req]))).code).toBe("22023");

      await s.query("select public.platform_support_request_update($1, 'answered', 'reply', 'Your trucks are back: refresh the board.')", [req]);
      await s.query("select public.platform_support_request_update($1, null, 'note', 'Called them too.')", [req]);
      const detail = await one<{ status: string; handled_by: string; notes: Array<{ kind: string; author: string }> }>(s, "select public.platform_support_request($1) r", [req]);
      expect(detail.status).toBe("answered");
      expect(detail.handled_by).toBe("Sam S.");
      expect(detail.notes.map((n) => [n.kind, n.author])).toEqual([["reply", "Sam S."], ["note", "Sam S."]]);

      await s.asAdmin();
      const audit = (await s.query<{ action: string; company: string }>("select action, detail->>'company_id' company from private.platform_audit where target_id = $1 order by id", [req])).rows;
      expect(audit.map((a) => a.action)).toEqual(["support_request_reply", "support_request_status", "support_request_note"]);
      expect(new Set(audit.map((a) => a.company))).toEqual(new Set([c.id]));

      // The person who asked sees the new status in Help (their own row); neither they nor the owner reach the inbox.
      await s.as(c.dispatcher);
      expect(await one<string>(s, "select status r from public.help_support_requests where id = $1", [req])).toBe("answered");
      for (const person of [c.dispatcher, c.owner]) {
        await s.as(person);
        expect((await pgError(s.query("select public.platform_support_inbox('open')"))).code).toBe("42501");
        expect((await pgError(s.query("select public.platform_support_request($1)", [req]))).code).toBe("42501");
        expect((await pgError(s.query("select public.platform_support_request_update($1, 'closed', 'note', '')", [req]))).code).toBe("42501");
        expect((await pgError(s.query("select * from private.help_support_notes"))).code).toBe("42501");
      }
    });
  });

  it("a staff member sees only their own visits and change requests", async () => {
    await withSession(async (s) => {
      const a = await staff(s, "support");
      const b = await staff(s, "support");
      const c = await company(s);
      await allowSupport(s, c);
      await s.as(a);
      await s.query("select public.platform_support_enter($1, 'Mine')", [c.id]);
      await s.as(b);
      await s.query("select public.platform_support_enter($1, 'Theirs')", [c.id]);
      const work = await one<{ visits: Array<{ reason: string; open: boolean }>; requests: unknown[] }>(s, "select public.platform_my_support_work() r");
      expect(work.visits.map((v) => v.reason)).toEqual(["Theirs"]);
      expect(work.visits[0].open).toBe(true);
      await s.as(c.owner);
      expect((await pgError(s.query("select public.platform_my_support_work()"))).code).toBe("42501");
    });
  });
});

describe("console search", () => {
  it("Support finds active companies and requests only; Admins also leads and team; wildcards are literal", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const sup = await staff(s, "support");
      const c = await company(s);
      await s.asAdmin();
      const name = (await s.query<{ name: string }>("select name from public.companies where id = $1", [c.id])).rows[0].name;
      const inactive = await s.createCompany("Console Gone Haul (test)");
      await s.query("update public.companies set active = false where id = $1", [inactive]);
      await s.query("insert into private.leads (kind, name, email, company_name) values ('demo', 'Console Lead', 'console-lead@test.example', 'Console Haul Prospect')");

      await s.as(sup);
      const r = await one<{ companies: Array<{ id: string }>; leads: unknown[]; team: unknown[]; prospects: unknown[] }>(s, "select public.platform_search('Console') r");
      expect(r.companies.map((x) => x.id)).toContain(c.id);
      expect(r.companies.map((x) => x.id)).not.toContain(inactive);
      expect(r.leads).toEqual([]);
      expect(r.team).toEqual([]);
      expect(r.prospects).toEqual([]);
      expect((await pgError(s.query("select public.platform_search('a')"))).code).toBe("22023");
      expect((await one<{ companies: unknown[] }>(s, "select public.platform_search('%%') r")).companies).toEqual([]);

      await s.as(adm);
      const ra = await one<{ companies: Array<{ id: string }>; leads: Array<{ name: string }> }>(s, "select public.platform_search('Console') r");
      expect(ra.companies.map((x) => x.id)).toEqual(expect.arrayContaining([c.id, inactive]));
      expect(ra.leads.map((l) => l.name)).toContain("Console Lead");
      expect((await one<{ companies: Array<{ id: string }> }>(s, "select public.platform_search($1) r", [name])).companies[0].id).toBe(c.id);

      await s.as(c.owner);
      expect((await pgError(s.query("select public.platform_search('Console')"))).code).toBe("42501");
    });
  });
});

describe("audit log filters and security overview", () => {
  it("Admins filter by who, what, company and day, and page by entry; Support and company people are refused", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin", "Ada Admin");
      const sup = await staff(s, "support");
      const c = await company(s);
      await allowSupport(s, c);
      await s.as(sup);
      await s.query("select public.platform_support_enter($1, 'one')", [c.id]);
      await s.query("select public.platform_support_leave()");
      await s.query("select public.platform_support_enter($1, 'two')", [c.id]);

      await s.as(adm);
      const rows = (await s.query<{ id: string; action: string; company_id: string; actor: string }>(
        "select * from public.platform_audit_search(null, null, $1, null, null, null, 100)", [c.id])).rows;
      expect(rows.map((r) => r.action)).toEqual(["support_entered", "support_left", "support_entered"]);
      expect(new Set(rows.map((r) => r.company_id))).toEqual(new Set([c.id]));
      // Days are the console's (Central time), not the database server's.
      const today = "(now() at time zone 'America/Chicago')::date";
      const byAction = (await s.query(`select * from public.platform_audit_search($1, 'support_left', $2, ${today}, ${today}, null, 100)`, [sup, c.id])).rows;
      expect(byAction).toHaveLength(1);
      const page2 = (await s.query("select * from public.platform_audit_search(null, null, $1, null, null, $2, 1)", [c.id, rows[0].id])).rows;
      expect(page2.map((r) => r.id)).toEqual([rows[1].id]);
      expect((await s.query(`select * from public.platform_audit_search(null, null, $1, ${today} + 1, null, null, 10)`, [c.id])).rows).toEqual([]);
      expect((await pgError(s.query(`select * from public.platform_audit_search(null, null, null, ${today}, ${today} - 1, null, 10)`))).code).toBe("22023");
      const facets = await one<{ actions: Array<{ action: string }>; actors: Array<{ id: string; name: string }> }>(s, "select public.platform_audit_facets() r");
      expect(facets.actions.map((a) => a.action)).toContain("support_entered");
      expect(facets.actors.map((a) => a.id)).toContain(sup);

      const sec = await one<Record<string, unknown>>(s, "select public.platform_security_overview() r");
      expect(Object.keys(sec).sort()).toEqual(["access", "as_of", "events", "mfa", "recent", "signin_failures"]);
      expect(JSON.stringify(sec)).not.toMatch(/hash|detail/);

      for (const who of [sup, c.owner]) {
        await s.as(who);
        expect((await pgError(s.query("select * from public.platform_audit_search(null, null, null, null, null, null, 10)"))).code).toBe("42501");
        expect((await pgError(s.query("select public.platform_audit_facets()"))).code).toBe("42501");
        expect((await pgError(s.query("select public.platform_security_overview()"))).code).toBe("42501");
      }
    });
  });
});

describe("lead demo dates, the pipeline and the Launchpad", () => {
  it("records demo dates in the lead's history, lists them in the pipeline and counts them on the Launchpad", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin", "Ada Admin");
      const sup = await staff(s, "support");
      await s.asAdmin();
      const lead = (await s.query<{ id: string }>("insert into private.leads (kind, name, email, status) values ('demo', 'Dana Demo', 'dana@test.example', 'demo_scheduled') returning id")).rows[0].id;
      await s.as(adm);
      const before = await one<{ demo_dated: number }>(s, "select public.platform_launchpad()->'leads' r");
      await s.query("select public.platform_lead_demo_date($1, current_date + 3)", [lead]);
      await s.query("select public.platform_lead_demo_date($1, current_date + 3)", [lead]); // unchanged: no second entry
      expect((await pgError(s.query("select public.platform_lead_demo_date($1, current_date + 400)", [lead]))).code).toBe("22023");
      const l = await one<{ demo_on: string; events: Array<{ action: string; actor: string }> }>(s, "select public.platform_lead($1) r", [lead]);
      expect(l.demo_on).toBeTruthy();
      expect(l.events.filter((e) => e.action === "demo_date_changed")).toEqual([expect.objectContaining({ actor: "Ada Admin" })]);
      const after = await one<{ demo_dated: number; next_demo_on: string }>(s, "select public.platform_launchpad()->'leads' r");
      expect(after.demo_dated).toBe(before.demo_dated + 1);
      const pipe = (await s.query<{ id: string; demo_on: string }>("select * from public.platform_lead_pipeline()")).rows;
      expect(pipe.find((p) => p.id === lead)?.demo_on).toBeTruthy();

      await s.as(sup);
      expect((await pgError(s.query("select public.platform_lead_demo_date($1, current_date)", [lead]))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.platform_lead_pipeline()"))).code).toBe("42501");
    });
  });

  it("counts imports for review only for real customer companies, and names acknowledgements by display name", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin", "Ada (Taviron)");
      const real = await company(s);
      const demo = await company(s, { demo: true });
      await s.as(adm);
      const n0 = await one<number>(s, "select (public.platform_launchpad()->'imports'->>'in_review')::int r");
      await s.asAdmin();
      const demoBatch = (await s.query<{ id: string }>("insert into private.import_batches (company_id, entity) values ($1, 'customers') returning id", [demo.id])).rows[0].id;
      await s.as(adm);
      const lp1 = await one<{ imports: { in_review: number }; attention: { items: Array<{ ref_id: string }> } }>(s, "select public.platform_launchpad() r");
      expect(lp1.imports.in_review).toBe(n0);
      expect(lp1.attention.items.map((i) => i.ref_id)).not.toContain(demoBatch);
      await s.asAdmin();
      await s.query("insert into private.import_batches (company_id, entity) values ($1, 'customers')", [real.id]);
      await s.as(adm);
      expect(await one<number>(s, "select (public.platform_launchpad()->'imports'->>'in_review')::int r")).toBe(n0 + 1);

      // A company with no subscription record has a true stage and is counted.
      const stage = (await s.query<{ stage: string }>("select stage from public.platform_support_companies() where id = $1", [real.id])).rows[0].stage;
      expect(stage).toBe("not_set_up");
      expect(await one<number>(s, "select (public.platform_console()->'customers'->>'not_set_up')::int r")).toBeGreaterThan(0);

      await s.query("select public.platform_attention_ack($1, 'on it')", [`company_setup:${real.id}`]);
      expect(await one<string>(s, "select public.platform_console()->'acks'->$1->>'by' r", [`company_setup:${real.id}`])).toBe("Ada (Taviron)");
    });
  });
});

describe("rollbacks", () => {
  // Retried: on the shared local database, a running app server can deadlock with this test's DDL now and then.
  it("each rollback removes its functions and the migrations apply again", { retry: 2 }, async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      for (const n of [...MIGRATIONS].reverse()) {
        await s.query(rollback(n)).catch((e: Error) => { throw new Error(`${n}: ${e.message}`); });
      }
      const left = (await s.query<{ name: string }>(
        `select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and p.proname in ('platform_company_health', 'platform_company_timeline', 'platform_company_usage',
           'platform_support_inbox', 'platform_support_request', 'platform_support_request_update', 'platform_my_support_work', 'platform_search',
           'platform_audit_search', 'platform_audit_facets', 'platform_security_overview', 'platform_lead_demo_date', 'platform_lead_pipeline',
           'person_name', 'company_stage')`)).rows;
      expect(left).toEqual([]);
      expect((await s.query("select 1 from information_schema.columns where table_schema = 'private' and table_name = 'leads' and column_name = 'demo_on'")).rows).toEqual([]);
      // The earlier functions still work after the rollback.
      const adm = await staff(s, "admin");
      await s.as(adm);
      await s.query("select public.platform_launchpad()");
      await s.query("select * from public.platform_support_companies()");
      await s.asAdmin();
      for (const n of MIGRATIONS) await s.query(migration(n));
      await s.as(adm);
      await s.query("select * from public.platform_company_health()");
    });
  });
});
