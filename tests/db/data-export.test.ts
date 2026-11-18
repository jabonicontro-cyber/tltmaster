import { describe, expect, it } from "vitest";
import { TOP_LINE, pgError, withSession, type Session } from "./helpers";

// Download all your data (EX1, migration 20261120024500): only the company's owner, two-step verified, reads its own
// company's rows; other roles (settings.manage included), a session without two-step, a table outside the fixed list
// and another company's rows are refused or never returned. Each download is recorded in the audit log without contents.

async function aal1(s: Session, userId: string) {
  await s.as(userId);
  await s.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal1" })]);
}

type Page = { columns: string[]; rows: Array<{ id: string; company_id: string }> };

describe("data export", () => {
  it("the owner reads every row of the company's own tables, page by page, and never another company's", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany("Export Other Co");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.asAdmin();
      await s.query("insert into public.customers (company_id, name) values ($1, 'Other Co Customer')", [other]);
      const owner = await s.createUser("owner");

      await s.as(owner);
      const summary = (await s.query<{ r: { counts: Record<string, number>; files: number } }>("select public.data_export_summary() as r")).rows[0].r;
      const first = (await s.query<{ r: Page }>("select public.data_export_rows('customers') as r")).rows[0].r;
      expect(first.columns).toContain("credit_limit_cents"); // money columns too: the owner holds billing.view
      expect(first.rows.length).toBe(Math.min(summary.counts.customers, 1000));
      expect(first.rows.every((r) => r.company_id === TOP_LINE)).toBe(true);
      expect(first.rows.map((r) => r.id)).toEqual([...first.rows.map((r) => r.id)].sort());
      // The next page starts after the last id given.
      const after = first.rows[0].id;
      const next = (await s.query<{ r: Page }>("select public.data_export_rows('customers', $1) as r", [after])).rows[0].r;
      expect(next.rows.map((r) => r.id)).toEqual(first.rows.slice(1).map((r) => r.id));
      // Every listed table answers for Top Line only.
      for (const table of Object.keys(summary.counts)) {
        const page = (await s.query<{ r: Page }>("select public.data_export_rows($1) as r", [table])).rows[0].r;
        expect(page.rows.every((r) => r.company_id === TOP_LINE), table).toBe(true);
      }
      const files = (await s.query<{ r: Array<{ path: string }> }>("select public.data_export_files(0, 1000) as r")).rows[0].r;
      expect(files.every((f) => f.path.startsWith(`${TOP_LINE}/`))).toBe(true);

      // The other company's owner sees only theirs.
      await s.as(otherOwner);
      const theirs = (await s.query<{ r: Page }>("select public.data_export_rows('customers') as r")).rows[0].r;
      expect(theirs.rows.map((r) => r.company_id)).toEqual([other]);
    });
  });

  it("refuses other roles, settings.manage included, a session without two-step, and tables outside the list", async () => {
    await withSession(async (s) => {
      for (const role of ["office", "dispatcher", "mechanic", "driver"] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await pgError(s.query("select public.data_export_rows('customers')"))).code, role).toBe("42501");
        expect((await pgError(s.query("select public.data_export_summary()"))).code, role).toBe("42501");
        expect((await pgError(s.query("select public.data_export_record('spreadsheets')"))).code, role).toBe("42501");
      }
      // An office manager who can change settings is still not the owner.
      await s.asAdmin();
      const has = await s.query("select 1 from public.role_permissions where company_id = $1 and role = 'office' and permission = 'settings.manage'", [TOP_LINE]);
      if (!has.rowCount) await s.query("insert into public.role_permissions (company_id, role, permission) values ($1, 'office', 'settings.manage')", [TOP_LINE]);
      const manager = await s.createUser("office");
      await s.as(manager);
      expect((await pgError(s.query("select public.data_export_files(0, 10)"))).message).toMatch(/Only the company's owner/);

      const owner = await s.createUser("owner");
      await aal1(s, owner);
      expect((await pgError(s.query("select public.data_export_rows('customers')"))).code).toBe("42501");

      await s.as(owner);
      for (const t of ["profiles", "accounting_connection_secrets", "audit_events", "customers; select 1", ""]) {
        expect((await pgError(s.query("select public.data_export_rows($1)", [t]))).code, t).toBe("22023");
      }
      expect((await pgError(s.query("select public.data_export_files(0, 5000)"))).code).toBe("22023");

      // Signed out: nothing at all.
      await s.as(null);
      expect((await pgError(s.query("select public.data_export_summary()"))).code).toBe("42501");
    });
  });

  it("records each download in the company's audit log, who and which part, with no contents", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      await s.query("select public.data_export_record('spreadsheets')");
      await s.query("select public.data_export_record('files-2')");
      expect((await pgError(s.query("select public.data_export_record('everything')"))).code).toBe("22023");
      await s.asAdmin();
      const rows = await s.query<{ company_id: string; actor_id: string; summary: string; details: Record<string, unknown> }>(
        "select company_id, actor_id, summary, details from public.audit_events where action = 'data_exported' and actor_id = $1 order by summary", [owner]);
      expect(rows.rows).toEqual([
        { company_id: TOP_LINE, actor_id: owner, summary: "Data exported: all records as spreadsheets", details: { part: "spreadsheets" } },
        { company_id: TOP_LINE, actor_id: owner, summary: "Data exported: photos and documents, part 2", details: { part: "files-2" } },
      ]);
    });
  });
});
