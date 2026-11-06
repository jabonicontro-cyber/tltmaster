// Company self-import (B106, migration 20261120004600): a company's administrator stages a spreadsheet of their own
// records, reviews every row, approves all at once and can undo (records become inactive, never deleted). Other roles
// and other companies cannot see or touch the import; the platform team's imports keep working.
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

type Row = { id: string; row: number; status: string; decision: string; can_override: boolean; outcome: string | null };

describe("company self-import", () => {
  it("stages, reviews, approves and undoes the company's own records", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany("Self Import Co (test)");
      const owner = await s.createUser("owner", { companyId: company });
      const dispatcher = await s.createUser("dispatcher", { companyId: company });
      await s.as(owner);
      await s.query("insert into public.customers (name) values ('Existing Builders')");
      const rows = [
        { row: 2, data: { name: "Alpha Paving", email: "ap@alpha.test" } },
        { row: 3, data: { name: "existing builders" } }, // duplicate of an existing customer
        { row: 4, data: { name: "" } }, // missing name
        { row: 5, data: { name: "Beta Grading" } },
      ];
      const batch = (await s.query<{ r: string }>("select public.company_import_stage('customers', 'customers.csv', '{}', $1::jsonb) r", [JSON.stringify(rows)])).rows[0].r;
      const staged = (await s.query<{ r: { status: string; source: string; rows: Row[] } }>("select public.company_import_batch($1) r", [batch])).rows[0].r;
      expect(staged.status).toBe("review");
      expect(staged.source).toBe("company");
      expect(staged.rows.map((r) => [r.row, r.status, r.decision])).toEqual([[2, "valid", "import"], [3, "duplicate", "skip"], [4, "error", "skip"], [5, "valid", "import"]]);
      expect((await s.query("select 1 from public.customers where name in ('Alpha Paving', 'Beta Grading')")).rowCount).toBe(0); // nothing yet
      const list = (await s.query<{ id: string; to_import: number; errors: number }>("select id, to_import, errors from public.company_import_batches()")).rows;
      expect(list).toEqual([{ id: batch, to_import: 2, errors: 1 }]);

      // An error row cannot be imported; skipping a valid row is allowed.
      expect((await pgError(s.query("select public.company_import_decide($1, 'import')", [staged.rows[2].id]))).code).toBe("22023");
      await s.query("select public.company_import_decide($1, 'skip')", [staged.rows[3].id]);

      // A dispatcher (no settings.manage) cannot see, stage or approve.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.company_import_batch($1)", [batch]))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.company_import_batches()"))).code).toBe("42501");
      expect((await pgError(s.query("select public.company_import_approve($1)", [batch]))).code).toBe("42501");
      expect((await pgError(s.query("select public.company_import_stage('customers', 'x.csv', '{}', '[]'::jsonb)"))).code).toBe("42501");

      // Another company's owner sees nothing and cannot act on it.
      const other = await s.createCompany("Other Import Co (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query<{ r: unknown }>("select public.company_import_batch($1) r", [batch])).rows[0].r).toBeNull();
      expect((await s.query("select * from public.company_import_batches()")).rowCount).toBe(0);
      expect((await pgError(s.query("select public.company_import_approve($1)", [batch]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.company_import_decide($1, 'skip')", [staged.rows[0].id]))).code).toBe("P0002");

      // Approve creates only Alpha Paving; it is recorded in the company's audit log.
      await s.as(owner);
      const out = (await s.query<{ r: { created: number } }>("select public.company_import_approve($1) r", [batch])).rows[0].r;
      expect(out.created).toBe(1);
      const alpha = (await s.query<{ id: string; active: boolean }>("select id, active from public.customers where name = 'Alpha Paving'")).rows;
      expect(alpha).toEqual([{ id: expect.any(String), active: true }]);
      expect((await s.query("select 1 from public.customers where name = 'Beta Grading'")).rowCount).toBe(0);
      expect((await pgError(s.query("select public.company_import_discard($1)", [batch]))).code).toBe("22023");

      // Undo needs a reason, makes the record inactive and never deletes it; it cannot run twice.
      expect((await pgError(s.query("select public.company_import_undo($1, '  ')", [batch]))).code).toBe("22023");
      const undo = (await s.query<{ r: { deactivated: number } }>("select public.company_import_undo($1, 'Wrong file') r", [batch])).rows[0].r;
      expect(undo.deactivated).toBe(1);
      expect((await s.query<{ active: boolean }>("select active from public.customers where id = $1", [alpha[0].id])).rows).toEqual([{ active: false }]);
      expect((await s.query<{ active: boolean }>("select active from public.customers where name = 'Existing Builders'")).rows).toEqual([{ active: true }]);
      const after = (await s.query<{ r: { status: string; revert_reason: string; rows: Row[] } }>("select public.company_import_batch($1) r", [batch])).rows[0].r;
      expect(after.status).toBe("deactivated");
      expect(after.revert_reason).toBe("Wrong file");
      expect(after.rows.find((r) => r.row === 2)?.outcome).toBe("deactivated");
      expect((await pgError(s.query("select public.company_import_undo($1, 'again')", [batch]))).code).toBe("22023");
      const actions = (await s.query<{ action: string }>("select action from public.audit_events where entity_id = $1 order by occurred_at, action", [batch])).rows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(["import.staged", "import.approved", "import.undone"]));

      // Demo samples are refused for a real company.
      expect((await pgError(s.query("select public.demo_import_samples()"))).code).toBe("42501");

      // A staged import can be discarded without creating anything.
      const second = (await s.query<{ r: string }>("select public.company_import_stage('materials', 'm.csv', '{}', $1::jsonb) r", [JSON.stringify([{ row: 2, data: { name: "Fill sand (test)" } }])])).rows[0].r;
      await s.query("select public.company_import_discard($1)", [second]);
      expect((await s.query("select 1 from public.materials where name = 'Fill sand (test)'")).rowCount).toBe(0);
    });
  });
});

describe("company import: job sites, trailers and driver credentials (LR3, 20261120008300)", () => {
  it("matches sites to customers, imports trailers, records CDL and medical dates unverified, and undoes", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany("Top Line Import Check (test)");
      const owner = await s.createUser("owner", { companyId: company });
      await s.as(owner);
      await s.query("insert into public.customers (name) values ('Kessler Builders'), ('Twin Name'), ('twin name')");
      type R = { r: { rows: Array<{ row: number; status: string; messages: string[] }> } };
      const stage = async (entity: string, rows: unknown[]) => {
        const id = (await s.query<{ r: string }>("select public.company_import_stage($1, 'f.csv', '{}', $2::jsonb) r", [entity, JSON.stringify(rows)])).rows[0].r;
        return { id, rows: (await s.query<R>("select public.company_import_batch($1) r", [id])).rows[0].r.rows };
      };

      const sites = await stage("sites", [
        { row: 2, data: { customer_name: "kessler builders", label: "North yard", line1: "12 Mill Rd", city: "Valparaiso", state: "IN" } },
        { row: 3, data: { customer_name: "Nobody Inc", line1: "1 Main" } },
        { row: 4, data: { customer_name: "Twin Name", line1: "2 Main" } },
        { row: 5, data: { customer_name: "Kessler Builders", line1: "12 MILL RD" } },
      ]);
      expect(sites.rows.map((r) => [r.row, r.status])).toEqual([[2, "valid"], [3, "error"], [4, "error"], [5, "duplicate"]]);
      expect(sites.rows[1].messages.join(" ")).toMatch(/No customer with this name/);
      expect(sites.rows[2].messages.join(" ")).toMatch(/More than one customer/);

      const trailers = await stage("trailers", [
        { row: 2, data: { unit_number: "T-1", trailer_type: "end_dump", make: "Mac" } },
        { row: 3, data: { unit_number: "T-2", trailer_type: "spaceship" } },
      ]);
      expect(trailers.rows.map((r) => r.status)).toEqual(["valid", "error"]);

      const drivers = await stage("drivers", [
        { row: 2, data: { name: "Ray Imported", cdl_class: "A", cdl_state: "IN", cdl_expires_on: "2027-03-31", medical_expires_on: "2026-12-15" } },
        { row: 3, data: { name: "No Class", cdl_expires_on: "2027-01-01" } },
        { row: 4, data: { name: "Bad Date", medical_expires_on: "soon" } },
      ]);
      expect(drivers.rows.map((r) => r.status)).toEqual(["valid", "error", "error"]);

      for (const b of [sites.id, trailers.id, drivers.id]) await s.query("select public.company_import_approve($1)", [b]);
      const site = (await s.query<{ label: string; customer: string; state: string }>("select s.label, c.name customer, s.state from public.customer_sites s join public.customers c on c.id = s.customer_id where s.line1 = '12 Mill Rd'")).rows;
      expect(site).toEqual([{ label: "North yard", customer: "Kessler Builders", state: "IN" }]);
      expect((await s.query("select 1 from public.trailers where unit_number = 'T-1' and trailer_type = 'end_dump'")).rowCount).toBe(1);
      const quals = (await s.query<{ kind: string; cdl_class: string | null; issuing_state: string; expires_on: string; verified_at: string | null }>(
        "select q.kind::text, q.cdl_class::text, q.issuing_state, q.expires_on::text, q.verified_at from public.driver_qualifications q join public.drivers d on d.id = q.driver_id where d.name = 'Ray Imported' order by q.kind")).rows;
      expect(quals).toEqual([
        { kind: "cdl", cdl_class: "A", issuing_state: "IN", expires_on: "2027-03-31", verified_at: null },
        { kind: "medical_card", cdl_class: null, issuing_state: "", expires_on: "2026-12-15", verified_at: null },
      ]);

      // Undo makes them inactive (never deleted).
      await s.query("select public.company_import_undo($1, 'test undo')", [sites.id]);
      await s.query("select public.company_import_undo($1, 'test undo')", [trailers.id]);
      expect((await s.query<{ active: boolean }>("select active from public.customer_sites where line1 = '12 Mill Rd'")).rows[0].active).toBe(false);
      expect((await s.query<{ active: boolean }>("select active from public.trailers where unit_number = 'T-1'")).rows[0].active).toBe(false);
    });
  });
});
