// Platform owner (N13): the Taviron team role is separate from company roles
// and granted only by the operator; website leads are written only by the
// server with rate limiting and duplicate merging; the demo company is
// isolated; onboarding imports are staged, reviewed, approved and reverted
// without touching anything they did not create. Sensitive actions are audited.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const service = (s: Session) => s.query("set local role service_role");
async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await service(s);
  expect((await s.query<{ r: { ok: boolean } }>("select public.platform_admin_grant($1, 'test') as r", [email])).rows[0].r.ok).toBe(true);
  await s.asAdmin();
  return { id, email };
}
const submit = async (s: Session, lead: Record<string, unknown>, ip = `ip-${randomUUID()}`) =>
  (await s.query<{ r: { ok: boolean; reason?: string } }>("select public.lead_submit($1::jsonb, $2) as r", [JSON.stringify(lead), ip])).rows[0].r;

describe("platform owner role", () => {
  it("only the operator grants it; company owners and anonymous visitors get nothing from platform functions", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const admin = await platformAdmin(s);
      await s.as(owner);
      expect((await s.query<{ r: boolean }>("select public.platform_whoami() as r")).rows[0].r).toBe(false);
      const calls = [
        "select * from public.platform_leads(null, null, false)",
        "select public.platform_overview()",
        "select * from public.platform_companies()",
        "select public.platform_demo_start('America/Chicago')",
        "select public.platform_demo_enter()",
        `select public.platform_create_company('Sneaky Co', 'America/Chicago', null)`,
        `select public.platform_import_stage('${TOP_LINE}', 'customers', 'x.csv', '{}', '[{"row":1,"data":{"name":"X"}}]')`,
        `select public.platform_import_approve('${randomUUID()}')`,
        "select * from public.platform_audit_recent(10)",
        "select * from public.platform_team()",
      ];
      for (const sql of calls) expect((await pgError(s.query(sql))).code, sql).toBe("42501");
      // Operator-only functions are not callable by app users, nor by the platform admin.
      for (const who of [owner, admin.id]) {
        await s.as(who);
        for (const sql of ["select public.platform_admin_grant('a@b.c', '')", "select public.platform_admin_revoke('a@b.c', '')", "select * from public.platform_admin_list()", "select public.lead_submit('{}', 'x')"]) {
          expect((await pgError(s.query(sql))).code, sql).toBe("42501");
        }
      }
      await s.as(null);
      expect((await pgError(s.query("select public.platform_whoami()"))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.platform_leads(null, null, false)"))).code).toBe("42501");

      await s.as(admin.id);
      expect((await s.query<{ r: boolean }>("select public.platform_whoami() as r")).rows[0].r).toBe(true);
      // Revoked → nothing.
      await s.asAdmin();
      await service(s);
      await s.query("select public.platform_admin_revoke($1, 'left the team')", [admin.email]);
      await s.as(admin.id);
      expect((await s.query<{ r: boolean }>("select public.platform_whoami() as r")).rows[0].r).toBe(false);
      expect((await pgError(s.query("select public.platform_overview()"))).code).toBe("42501");
      await s.asAdmin();
      const audit = await s.query<{ action: string }>("select action from private.platform_audit where target_id = $1 order by id", [admin.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(["admin_granted", "admin_revoked"]);
      // The audit log is append-only.
      expect((await pgError(s.query("delete from private.platform_audit"))).code).toBe("42501");
    });
  });
});

describe("website leads", () => {
  it("are validated, merged by email, rate limited per address, and worked with a full history", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await service(s);
      const email = `lead-${randomUUID().slice(0, 8)}@example.com`;
      const ip = `ip-${randomUUID()}`;
      expect(await submit(s, { kind: "demo", name: "Pat Example", email, company_name: "Example Hauling (test)", fleet_size: "6-15", message: "Interested in dispatch." }, ip)).toEqual({ ok: true });
      expect(await submit(s, { kind: "contact", name: "Pat Example", email: email.toUpperCase(), message: "Following up." }, ip)).toEqual({ ok: true }); // merged
      expect(await submit(s, { kind: "contact", name: "", email }, ip)).toEqual({ ok: false, reason: "invalid" });
      expect(await submit(s, { kind: "contact", name: "X", email: "not-an-email" }, ip)).toEqual({ ok: false, reason: "invalid" });
      expect(await submit(s, { kind: "other", name: "X", email }, ip)).toEqual({ ok: false, reason: "invalid" });
      expect(await submit(s, { kind: "contact", name: "X", email: `x${email}` }, ip)).toEqual({ ok: false, reason: "rate_limited" }); // 5 per 15 minutes
      expect((await submit(s, { kind: "contact", name: "Other", email: `someone-${randomUUID().slice(0, 8)}@example.org` })).ok).toBe(true); // another address is unaffected

      await s.as(admin.id);
      const list = await s.query<{ id: string; submission_count: number; kind: string; status: string }>("select * from public.platform_leads($1, null, false)", [email]);
      expect(list.rows).toHaveLength(1);
      expect(list.rows[0]).toMatchObject({ submission_count: 2, kind: "demo", status: "new" });
      const id = list.rows[0].id;
      expect((await s.query("select * from public.platform_leads('Example Hauling', null, false)")).rowCount).toBeGreaterThanOrEqual(1);

      await s.query("select public.platform_lead_update($1, 'contacted', $2, current_date)", [id, admin.id]);
      await s.query("select public.platform_lead_note($1, 'Called; wants a demo next week.')", [id]);
      expect((await pgError(s.query("select public.platform_lead_update($1, 'bogus', null, null)", [id]))).code).toBe("22023");
      const other = await s.createUser("owner"); // not on the platform team
      expect((await pgError(s.query("select public.platform_lead_update($1, 'contacted', $2, null)", [id, other]))).code).toBe("22023");
      const lead = (await s.query<{ r: { status: string; owner_id: string; events: Array<{ action: string; note: string }> } }>("select public.platform_lead($1) as r", [id])).rows[0].r;
      expect(lead.status).toBe("contacted");
      expect(lead.owner_id).toBe(admin.id);
      expect(lead.events.map((e) => e.action)).toEqual(["submitted", "resubmitted", "status_changed", "owner_changed", "follow_up_changed", "note_added"]);
      expect((await s.query("select * from public.platform_leads(null, null, true) where id = $1", [id])).rowCount).toBe(1); // due today
      // Spam is hidden from the default list.
      await s.query("select public.platform_lead_update($1, 'spam', null, null)", [id]);
      expect((await s.query("select * from public.platform_leads($1, null, false)", [email])).rowCount).toBe(0);
      expect((await s.query("select * from public.platform_leads($1, 'spam', false)", [email])).rowCount).toBe(1);
      // Nobody else can read leads directly.
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select * from private.leads"))).code).toBe("42501");
    });
  });
});

describe("demo company", () => {
  it("is a separate company; a new demo deactivates the old one and never touches real companies", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.asAdmin();
      const before = (await s.query<{ n: number }>("select count(*)::int n from public.customers where company_id = $1", [TOP_LINE])).rows[0].n;
      await s.as(admin.id);
      const d1 = (await s.query<{ id: string }>("select public.platform_demo_start('America/Denver') as id")).rows[0].id;
      const access = (await s.query<{ r: { company_id: string; role: string } }>("select public.my_access() as r")).rows[0].r;
      expect(access).toMatchObject({ company_id: d1, role: "owner" });
      // As demo owner the admin works only inside the demo.
      await s.query("insert into public.customers (name) values ('Demo Customer (fictional)')");
      expect((await s.query("select 1 from public.customers where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      const d2 = (await s.query<{ id: string }>("select public.platform_demo_start('America/Chicago') as id")).rows[0].id;
      expect(d2).not.toBe(d1);
      await s.asAdmin();
      const rows = (await s.query<{ id: string; active: boolean; is_demo: boolean }>("select id, active, is_demo from public.companies where id in ($1, $2)", [d1, d2])).rows;
      expect(rows.find((r) => r.id === d1)).toMatchObject({ active: false, is_demo: true });
      expect(rows.find((r) => r.id === d2)).toMatchObject({ active: true, is_demo: true });
      expect((await s.query("select 1 from public.customers where company_id = $1", [d1])).rowCount).toBe(1); // kept, not deleted
      expect((await s.query<{ n: number }>("select count(*)::int n from public.customers where company_id = $1", [TOP_LINE])).rows[0].n).toBe(before);
      // The demo is not offered as an import target, nor listed with real companies.
      await s.as(admin.id);
      expect((await s.query("select 1 from public.platform_companies() where id = $1", [d2])).rowCount).toBe(0);
      expect((await pgError(s.query(`select public.platform_import_stage($1, 'customers', 'x.csv', '{}', '[{"row":1,"data":{"name":"X"}}]')`, [d2]))).code).toBe("P0002");
      await s.asAdmin();
      expect((await s.query<{ action: string }>("select action from private.platform_audit where target_id = $1", [d2])).rows.map((r) => r.action)).toEqual(["demo_started"]);
    });
  });
});

describe("team-led onboarding imports", () => {
  it("stage → review → approve creates only approved rows; revert removes untouched records and keeps used or changed ones", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin.id);
      const company = (await s.query<{ id: string }>("select public.platform_create_company('Lakeside Hauling (test)', 'America/Chicago', null) as id")).rows[0].id;
      // A record that existed before the import (must never be touched).
      await s.asAdmin();
      const existing = (await s.query<{ id: string }>("insert into public.customers (company_id, name, email) values ($1, 'Existing Builders', 'ops@existing.test') returning id", [company])).rows[0].id;
      await s.as(admin.id);
      const rows = [
        { row: 2, data: { name: "Alpha Paving", email: "ap@alpha.test", customer_type: "commercial" } },
        { row: 3, data: { name: "Beta Grading", po_required: "true" } },
        { row: 4, data: { name: "existing builders" } }, // duplicate of an existing customer
        { row: 5, data: { name: "Alpha Paving" } }, // duplicate within the file
        { row: 6, data: { name: "" } }, // missing name
        { row: 7, data: { name: "Gamma Homes", customer_type: "industrial" }, errors: [] }, // bad type
        { row: 8, data: { name: "Delta Sitework", unknown_column: "dropped" } },
      ];
      const batch = (await s.query<{ id: string }>("select public.platform_import_stage($1, 'customers', 'customers.csv', '{}', $2::jsonb) as id", [company, JSON.stringify(rows)])).rows[0].id;
      const staged = (await s.query<{ r: { rows: Array<{ id: string; row: number; status: string; decision: string; can_override: boolean; data: Record<string, string>; messages: string[] }> } }>("select public.platform_import_batch($1) as r", [batch])).rows[0].r.rows;
      const byRow = Object.fromEntries(staged.map((r) => [r.row, r]));
      expect(staged.map((r) => [r.row, r.status, r.decision])).toEqual([
        [2, "valid", "import"], [3, "valid", "import"], [4, "duplicate", "skip"], [5, "duplicate", "skip"], [6, "error", "skip"], [7, "error", "skip"], [8, "valid", "import"],
      ]);
      expect(byRow[4].can_override).toBe(true);
      expect(byRow[5].can_override).toBe(false);
      expect(byRow[8].data).toEqual({ name: "Delta Sitework" });
      // Nothing exists until approval.
      await s.asAdmin();
      expect((await s.query("select 1 from public.customers where company_id = $1", [company])).rowCount).toBe(1);
      await s.as(admin.id);
      expect((await pgError(s.query("select public.platform_import_decide($1, 'import')", [byRow[6].id]))).code).toBe("22023");
      expect((await pgError(s.query("select public.platform_import_decide($1, 'import')", [byRow[5].id]))).code).toBe("22023");
      await s.query("select public.platform_import_decide($1, 'skip')", [byRow[8].id]);
      await s.query("select public.platform_import_decide($1, 'import')", [byRow[4].id]); // reviewer: a different customer with the same name
      expect((await s.query<{ r: { created: number } }>("select public.platform_import_approve($1) as r", [batch])).rows[0].r).toEqual({ created: 3 });
      expect((await pgError(s.query("select public.platform_import_approve($1)", [batch]))).code).toBe("22023"); // once only
      expect((await pgError(s.query("select public.platform_import_decide($1, 'skip')", [byRow[2].id]))).code).toBe("P0002"); // decisions are closed

      await s.asAdmin();
      const created = (await s.query<{ name: string; po_required: boolean; customer_number: string }>("select name, po_required, customer_number from public.customers where company_id = $1 order by name", [company])).rows;
      expect(created.map((c) => c.name)).toEqual(["Alpha Paving", "Beta Grading", "Existing Builders", "existing builders"]);
      expect(created.find((c) => c.name === "Beta Grading")!.po_required).toBe(true);
      expect(created.every((c) => c.customer_number.startsWith("C-"))).toBe(true);
      // After approval the records are in use: Beta gets a contact (now used), "existing builders" is edited.
      const ids = Object.fromEntries((await s.query<{ id: string; name: string }>("select id, name from public.customers where company_id = $1", [company])).rows.map((r) => [r.name, r.id]));
      await s.query("insert into public.customer_contacts (company_id, customer_id, name) values ($1, $2, 'Robin Contact')", [company, ids["Beta Grading"]]);
      await s.query("update public.customers set updated_at = now() + interval '1 minute', notes = 'edited after import' where id = $1", [ids["existing builders"]]);

      await s.as(admin.id);
      expect((await pgError(s.query("select public.platform_import_revert($1, '')", [batch]))).code).toBe("22023");
      expect((await s.query<{ r: unknown }>("select public.platform_import_revert($1, 'Wrong file') as r", [batch])).rows[0].r).toEqual({ removed: 1, kept_inactive: 2 });
      await s.asAdmin();
      const after = (await s.query<{ name: string; active: boolean }>("select name, active from public.customers where company_id = $1 order by name", [company])).rows;
      expect(after).toEqual([
        { name: "Beta Grading", active: false },
        { name: "Existing Builders", active: true }, // untouched: it was not created by the batch
        { name: "existing builders", active: false },
      ]);
      expect((await s.query("select 1 from public.customers where id = $1 and active", [existing])).rowCount).toBe(1);
      expect((await s.query("select 1 from public.customer_contacts where customer_id = $1", [ids["Beta Grading"]])).rowCount).toBe(1);
      const outcomes = (await s.query<{ row_number: number; outcome: string }>("select row_number, outcome from private.import_rows where batch_id = $1 and outcome <> '' order by row_number", [batch])).rows;
      expect(outcomes).toEqual([{ row_number: 2, outcome: "removed" }, { row_number: 3, outcome: "kept_in_use" }, { row_number: 4, outcome: "kept_changed" }]);
      expect((await s.query<{ action: string }>("select action from private.platform_audit where target_id = $1 order by id", [batch])).rows.map((r) => r.action)).toEqual(["import_staged", "import_approved", "import_reverted"]);
    });
  });

  it("an import is all or nothing, and trucks, materials and drivers follow the company's rules", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin.id);
      const company = (await s.query<{ id: string }>("select public.platform_create_company('Ridgeline Haul (test)', 'America/Chicago', null) as id")).rows[0].id;
      const stage = async (entity: string, rows: unknown[]) => (await s.query<{ id: string }>("select public.platform_import_stage($1, $2, 'f.csv', '{}', $3::jsonb) as id", [company, entity, JSON.stringify(rows)])).rows[0].id;
      const statuses = async (b: string) => ((await s.query<{ r: { rows: Array<{ status: string }> } }>("select public.platform_import_batch($1) as r", [b])).rows[0].r.rows).map((r) => r.status);

      const trucks = await stage("trucks", [
        { row: 2, data: { unit_number: "T-10", truck_type: "tri_axle_dump", model_year: "2019" } },
        { row: 3, data: { unit_number: "t-10 ", truck_type: "tri_axle_dump" } },
        { row: 4, data: { unit_number: "T-11", truck_type: "spaceship" } },
        { row: 5, data: { unit_number: "T-12", truck_type: "tandem_axle_dump", model_year: "not a year" } },
      ]);
      expect(await statuses(trucks)).toEqual(["valid", "duplicate", "error", "valid"]);
      // Row 5's bad year is caught at approval and nothing is created.
      const err = await pgError(s.query("select public.platform_import_approve($1)", [trucks]));
      expect(err.code).toBe("22023");
      expect(err.message).toMatch(/Row 5 could not be imported.*Nothing was imported/);
      await s.asAdmin();
      expect((await s.query("select 1 from public.trucks where company_id = $1", [company])).rowCount).toBe(0);
      await s.as(admin.id);
      await s.query("select public.platform_import_discard($1)", [trucks]);

      const mats = await stage("materials", [
        { row: 2, data: { name: "Pea gravel", code: "PG", default_unit_code: "ton" } },
        { row: 3, data: { name: "Mulch", default_unit_code: "bucket" } },
      ]);
      expect(await statuses(mats)).toEqual(["valid", "error"]);
      expect((await s.query<{ r: { created: number } }>("select public.platform_import_approve($1) as r", [mats])).rows[0].r.created).toBe(1);

      const drivers = await stage("drivers", [
        { row: 2, data: { name: "Sam Rivera", employee_number: "E-1", hire_date: "2024-03-01" } },
        { row: 3, data: { name: "Lee Park" } },
      ]);
      expect((await s.query<{ r: { created: number } }>("select public.platform_import_approve($1) as r", [drivers])).rows[0].r.created).toBe(2);
      const again = await stage("drivers", [{ row: 2, data: { name: "Someone", employee_number: "e-1" } }, { row: 3, data: { name: "lee park" } }]);
      const rows = (await s.query<{ r: { rows: Array<{ status: string; can_override: boolean }> } }>("select public.platform_import_batch($1) as r", [again])).rows[0].r.rows;
      expect(rows.map((r) => [r.status, r.can_override])).toEqual([["duplicate", false], ["duplicate", true]]);
      // Everything stays in the target company.
      await s.asAdmin();
      expect((await s.query("select 1 from public.drivers where company_id = $1", [company])).rowCount).toBe(2);
      expect((await s.query("select 1 from public.drivers where name = 'Sam Rivera' and company_id <> $1", [company])).rowCount).toBe(0);
    });
  });
});
