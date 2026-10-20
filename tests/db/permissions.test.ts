import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession } from "./helpers";

afterAll(() => pool.end());

describe("row level security and permissions", () => {
  it("anonymous requests cannot read or write business data", async () => {
    await withSession(async (s) => {
      await s.as(null);
      for (const table of ["customers", "materials", "quotes", "quote_lines", "audit_events", "profiles", "company_settings"]) {
        const err = await pgError(s.query(`select * from public.${table} limit 1`));
        expect(err.code, table).toBe("42501");
      }
      const err = await pgError(s.query("select public.save_quote_draft('{}'::jsonb)"));
      expect(err.code).toBe("42501");
    });
  });

  it("a signed-in user without a role sees nothing", async () => {
    await withSession(async (s) => {
      const pending = await s.createUser(null);
      await s.as(pending);
      expect((await s.query("select * from public.customers")).rowCount).toBe(0);
      expect((await s.query("select * from public.materials")).rowCount).toBe(0);
      expect((await s.query("select * from public.company_settings")).rowCount).toBe(0);
      const err = await pgError(s.query("insert into public.customers (name) values ('X')"));
      expect(err.code).toBe("42501");
      // Can see their own profile (to show "waiting for access").
      expect((await s.query("select * from public.profiles")).rowCount).toBe(1);
    });
  });

  it("deactivated users lose access", async () => {
    await withSession(async (s) => {
      const inactive = await s.createUser("office", { active: false });
      await s.as(inactive);
      expect((await s.query("select * from public.customers")).rowCount).toBe(0);
    });
  });

  it("dispatchers can read customers and quotes but not change them", async () => {
    await withSession(async (s) => {
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await s.query("select * from public.customers")).rowCount).toBeGreaterThan(0);
      expect((await pgError(s.query("insert into public.customers (name) values ('Nope')"))).code).toBe("42501");
      const upd = await s.query("update public.customers set notes = 'x'");
      expect(upd.rowCount).toBe(0);
      expect((await pgError(s.query("select public.save_quote_draft('{}'::jsonb)"))).code).toBe("42501");
      expect((await pgError(s.query("insert into public.materials (name, default_unit_code) values ('x','ton')"))).code).toBe("42501");
    });
  });

  it("office staff can create and edit customers; numbers are assigned automatically", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const ins = await s.query<{ id: string; customer_number: string; created_by: string }>(
        "insert into public.customers (name, customer_type) values ('Test Customer LLC', 'commercial') returning id, customer_number, created_by",
      );
      expect(ins.rows[0].customer_number).toMatch(/^CUS-\d{4,}$/);
      expect(ins.rows[0].created_by).toBe(office);
      const id = ins.rows[0].id;
      // customer_number cannot be changed by an update
      await s.query("update public.customers set name = 'Renamed LLC', customer_number = 'HACK' where id = $1", [id]);
      const row = await s.query<{ name: string; customer_number: string }>("select name, customer_number from public.customers where id = $1", [id]);
      expect(row.rows[0].name).toBe("Renamed LLC");
      expect(row.rows[0].customer_number).toMatch(/^CUS-\d{4,}$/);
      // no hard deletes
      const del = await pgError(s.query("delete from public.customers where id = $1", [id]));
      expect(del.code).toBe("42501");
      // audited
      await s.asAdmin();
      const audit = await s.query("select action from public.audit_events where entity_id = $1 order by occurred_at", [id]);
      expect(audit.rows.map((r) => r.action)).toEqual(["customer.created", "customer.updated"]);
    });
  });

  it("office staff cannot change company settings, users or permissions", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const upd = await s.query("update public.company_settings set company_name = 'X'");
      expect(upd.rowCount).toBe(0);
      expect((await pgError(s.query("select public.set_user_access($1, 'owner', true, 'Me')", [office]))).code).toBe("42501");
      expect((await pgError(s.query("select public.set_role_permission('office', 'pricing.override', true)"))).code).toBe("42501");
      expect((await pgError(s.query("select public.remove_sample_data()"))).code).toBe("42501");
      // Only order and fleet history are visible without audit.view (order_management and fleet_registry migrations).
      expect((await s.query("select * from public.audit_events where entity_type not in ('order', 'truck', 'trailer', 'driver', 'driver_qualification')")).rowCount).toBe(0);
    });
  });

  it("nobody can write quote tables directly; only through functions", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const cust = await s.query<{ id: string }>("select id from public.customers limit 1");
      expect((await pgError(s.query("insert into public.quotes (quote_number, customer_id) values ('Q-X', $1)", [cust.rows[0].id]))).code).toBe("42501");
      expect((await pgError(s.query("update public.quote_versions set total_cents = 1"))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.quote_lines"))).code).toBe("42501");
    });
  });

  it("the audit log is append-only, even for the database owner", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      await s.query("insert into public.audit_events (action, entity_type, summary) values ('test', 'test', 'x')");
      expect((await pgError(s.query("update public.audit_events set summary = 'changed'"))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.audit_events"))).code).toBe("42501");
    });
  });

  it("owners manage users; the last active owner cannot be removed", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      // Make this owner the only active owner within the transaction.
      await s.query("update public.company_memberships set active = false where role = 'owner' and company_id = $1", [TOP_LINE]);
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      await s.as(owner);
      await s.query("select public.set_user_access($1, 'dispatcher', true, 'Dana Dispatcher')", [office]);
      const p = await s.query<{ role: string }>("select role from public.company_memberships where user_id = $1", [office]);
      expect(p.rows[0].role).toBe("dispatcher");
      const err = await pgError(s.query("select public.set_user_access($1, 'office', true, 'Owner')", [owner]));
      expect(err.message).toMatch(/at least one active owner/i);
    });
  });

  it("owners can grant permissions to other roles but not change owner permissions", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      await s.as(office);
      let access = await s.query<{ a: { permissions: string[] } }>("select public.my_access() as a");
      expect(access.rows[0].a.permissions).not.toContain("pricing.override");

      await s.as(owner);
      await s.query("select public.set_role_permission('office', 'pricing.override', true)");
      expect((await pgError(s.query("select public.set_role_permission('owner', 'quotes.view', false)"))).message).toMatch(/owner/i);

      await s.as(office);
      access = await s.query("select public.my_access() as a");
      expect(access.rows[0].a.permissions).toContain("pricing.override");
    });
  });
});

describe("audit noise", () => {
  it("allocating document numbers is not audited, but manual numbering changes are", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      await s.query("insert into public.customers (name) values ('Audit Test Co')");
      await s.query("update public.document_sequences set pad = 6 where key = 'order'");
      await s.asAdmin();
      const rows = await s.query<{ action: string }>("select action from public.audit_events where entity_type = 'document_sequence' and actor_id = $1", [owner]);
      expect(rows.rows.map((r) => r.action)).toEqual(["document_sequence.updated"]);
    });
  });
});

describe("permission catalog", () => {
  it("the application's permission list matches the database", async () => {
    const { PERMISSIONS } = await import("@/lib/permissions");
    await withSession(async (s) => {
      await s.asAdmin();
      const rows = await s.query<{ code: string }>("select code from public.permissions order by code");
      expect(rows.rows.map((r) => r.code)).toEqual([...PERMISSIONS].sort());
    });
  });
});
