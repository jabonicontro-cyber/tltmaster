// Company CRM slice 1 (20261119000100): prospects and customers are one record; activities are append-only; tasks
// and opportunities belong to the company and its people; a won opportunity or a first order makes a prospect a
// customer; history and duplicate checks run with the caller's rights.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TOP_LINE, pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const prospect = async (s: Session, name = `Prospect Hauling ${randomUUID().slice(0, 6)} (test)`) =>
  (await s.query<{ id: string }>("insert into public.customers (name, relationship, email, phone) values ($1, 'prospect', $2, '(555) 010-' || lpad((floor(random() * 9999))::text, 4, '0')) returning id", [name, `${randomUUID().slice(0, 8)}@prospect.example`])).rows[0].id;

describe("company CRM", () => {
  it("office records activities, tasks and opportunities; dispatchers read only; drivers see nothing", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const driver = await s.createUser("driver");
      await s.as(office);
      const c = await prospect(s);
      await s.query("insert into public.customer_activities (customer_id, kind, subject, body) values ($1, 'call', 'Intro call', 'Wants 3 loads a week')", [c]);
      await s.query("insert into public.customer_tasks (customer_id, title, due_on, assigned_to) values ($1, 'Send rates', current_date + 2, $2)", [c, office]);
      await s.query("insert into public.crm_opportunities (customer_id, title, value_cents, follow_up_on) values ($1, 'Spring gravel', 1250000, current_date + 3)", [c]);

      await s.as(dispatcher);
      expect((await s.query("select 1 from public.customer_activities where customer_id = $1", [c])).rowCount).toBe(1);
      expect((await pgError(s.query("insert into public.customer_activities (customer_id, kind, subject) values ($1, 'note', 'x')", [c]))).code).toBe("42501");
      expect((await s.query("update public.crm_opportunities set stage = 'won' where customer_id = $1", [c])).rowCount).toBe(0);

      await s.as(driver);
      for (const t of ["customer_activities", "customer_tasks", "crm_opportunities", "crm_opportunity_events"]) {
        expect((await s.query(`select 1 from public.${t}`)).rowCount, t).toBe(0);
      }
      // Activities are append-only, even for the person who wrote them.
      await s.as(office);
      expect((await s.query("update public.customer_activities set subject = 'changed' where customer_id = $1", [c])).rowCount).toBe(0);
      expect((await s.query("delete from public.customer_activities where customer_id = $1", [c])).rowCount).toBe(0);
    });
  });

  it("another company sees nothing and cannot point its records at this company's customers or people", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const c = await prospect(s);
      await s.query("insert into public.crm_opportunities (customer_id, title) values ($1, 'Mine')", [c]);
      const other = await s.createCompany("Other Hauling (test)");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select 1 from public.crm_opportunities")).rowCount).toBe(0);
      expect((await s.query("select public.customer_history($1) as h", [c])).rows[0].h.orders).toBe(0);
      expect((await pgError(s.query("insert into public.crm_opportunities (customer_id, title) values ($1, 'Steal')", [c]))).code).toBe("23503");
      // Nor assign work to someone outside the company.
      const own = (await s.query<{ id: string }>("insert into public.customers (name) values ('Other customer (test)') returning id")).rows[0].id;
      expect((await pgError(s.query("insert into public.customer_tasks (customer_id, title, assigned_to) values ($1, 'x', $2)", [own, office]))).message).toMatch(/someone in this company/);
      expect((await pgError(s.query("update public.customers set account_owner_id = $2 where id = $1", [own, office]))).message).toMatch(/someone in this company/);
    });
  });

  it("stages are recorded; lost needs a reason; won turns the prospect into a customer (same record)", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const c = await prospect(s);
      const o = (await s.query<{ id: string }>("insert into public.crm_opportunities (customer_id, title, owner_id) values ($1, 'Fill dirt', $2) returning id", [c, office])).rows[0].id;
      await s.query("update public.crm_opportunities set stage = 'quoting' where id = $1", [o]);
      expect((await pgError(s.query("update public.crm_opportunities set stage = 'lost' where id = $1", [o]))).code).toBe("23514");
      await s.query("update public.crm_opportunities set stage = 'won' where id = $1", [o]);
      const opp = (await s.query<{ closed_at: string | null }>("select closed_at from public.crm_opportunities where id = $1", [o])).rows[0];
      expect(opp.closed_at).not.toBeNull();
      const events = (await s.query<{ from_stage: string | null; to_stage: string }>("select from_stage, to_stage from public.crm_opportunity_events where opportunity_id = $1 order by id", [o])).rows;
      expect(events).toEqual([{ from_stage: null, to_stage: "new" }, { from_stage: "new", to_stage: "quoting" }, { from_stage: "quoting", to_stage: "won" }]);
      expect((await s.query<{ relationship: string }>("select relationship from public.customers where id = $1", [c])).rows[0].relationship).toBe("customer");
      expect((await s.query<{ n: string }>("select count(*) n from public.customers where id = $1", [c])).rows[0].n).toBe("1");
      await s.asAdmin();
      expect(Number((await s.query<{ n: string }>("select count(*) n from public.audit_events where entity_id = $1", [o])).rows[0].n)).toBeGreaterThanOrEqual(3);
    });
  });

  it("tasks record who completed them; tags are cleaned; duplicates are found by name, email or phone", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const name = `Granite Supply ${randomUUID().slice(0, 6)}`;
      const c = (await s.query<{ id: string }>("insert into public.customers (name, email, phone, tags) values ($1, 'orders@granite.example', '(555) 222-3344', array['  Quarry ', 'quarry', '', 'Priority']) returning id", [`${name}, Inc.`])).rows[0].id;
      // Trimmed, blanks dropped, exact duplicates merged; case variants stay distinct. The stored order follows the
      // database collation (C.UTF-8 locally, en_US.utf8 in CI), so compare in code-point order.
      expect([...(await s.query<{ tags: string[] }>("select tags from public.customers where id = $1", [c])).rows[0].tags].sort()).toEqual(["Priority", "Quarry", "quarry"]);
      const t = (await s.query<{ id: string }>("insert into public.customer_tasks (customer_id, title) values ($1, 'Call back') returning id", [c])).rows[0].id;
      await s.query("update public.customer_tasks set status = 'done' where id = $1", [t]);
      expect((await s.query<{ completed_by: string }>("select completed_by from public.customer_tasks where id = $1", [t])).rows[0].completed_by).toBe(office);
      const dup = async (n: string, e: string, p: string) => (await s.query<{ id: string; matched_on: string }>("select * from public.customer_duplicates($1, $2, $3)", [n, e, p])).rows.filter((r) => r.id === c);
      expect((await dup(name.toUpperCase(), "", ""))[0]?.matched_on).toBe("name");
      expect((await dup("Something else", "ORDERS@granite.example", ""))[0]?.matched_on).toBe("email");
      expect((await dup("Something else", "", "555.222.3344"))[0]?.matched_on).toBe("phone");
      expect(await dup("Something else", "", "")).toEqual([]);
    });
  });

  it("customer history comes from real orders; a first order makes a prospect a customer", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const c = await prospect(s);
      let h = (await s.query<{ h: { orders: number; quiet: boolean | null } }>("select public.customer_history($1) as h", [c])).rows[0].h;
      expect(h.orders).toBe(0);
      expect(h.quiet).toBeNull(); // never ordered: not "quiet", just new
      await s.query("select public.save_order_draft($1::jsonb)", [JSON.stringify({ customer_id: c, site_line1: "1 Test Rd", order_date: new Date().toISOString().slice(0, 10), project_name: "CRM test", lines: [] })]);
      h = (await s.query<{ h: { orders: number; quiet: boolean | null } }>("select public.customer_history($1) as h", [c])).rows[0].h;
      expect(h.orders).toBe(1);
      expect(h.quiet).toBe(false);
      expect((await s.query<{ relationship: string }>("select relationship from public.customers where id = $1", [c])).rows[0].relationship).toBe("customer");
      expect(TOP_LINE).toBeTruthy();
    });
  });
});
