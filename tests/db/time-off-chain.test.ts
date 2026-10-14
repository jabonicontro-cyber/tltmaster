import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

// Time-off approval chains (20261112000400; owner 2026-10-13): ordered steps by role; each step needs the role and
// time_off.approve; only the last step approves (and uses PTO hours); a denial at any step ends the request; no
// chain = one approval as before. Fictional data; every test runs in a rolled-back transaction.

afterAll(() => pool.end());

async function employee(s: Session, userId: string) {
  await s.asAdmin();
  return (await s.query<{ id: string }>("insert into public.employees (company_id, user_id, full_name) values ('00000000-0000-4000-8000-000000000001', $1, 'Chain Person') returning id", [userId])).rows[0].id;
}
const save = (s: Session, p: Record<string, unknown>) => s.query<{ r: { id: string } }>("select public.time_off_save($1::jsonb) as r", [JSON.stringify(p)]).then((r) => r.rows[0].r);
const decide = (s: Session, id: string, d: string) => s.query<{ r: { status: string; step?: number } }>("select public.time_off_decide($1, $2, '') as r", [id, d]).then((r) => r.rows[0].r);
const chain = (s: Session, steps: Array<{ role: string; label: string }>) => s.query("select public.time_off_set_chain($1::jsonb)", [JSON.stringify(steps)]);
const status = (s: Session, id: string) => s.query<{ status: string; approval_step: number | null }>("select status, approval_step from public.time_off_requests where id = $1", [id]).then((r) => r.rows[0]);

describe("time-off approval chains", () => {
  it("office then owner: each step needs its role; only the last approves; history records the steps", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const driver = await s.createUser("driver");
      await employee(s, driver);
      // Office decides step 1 only if its role has time_off.approve (owners grant it per role).
      await s.asAdmin();
      await s.query("insert into public.role_permissions (company_id, role, permission) values ('00000000-0000-4000-8000-000000000001', 'office', 'time_off.approve') on conflict do nothing");
      await s.as(owner);
      await chain(s, [{ role: "office", label: "Office review" }, { role: "owner", label: "Owner" }]);
      await s.as(driver);
      const r = await save(s, { category: "personal", start_date: addDays(today, 9), end_date: addDays(today, 9) });
      await s.as(owner);
      expect((await pgError(decide(s, r.id, "approved"))).message).toMatch(/waits for step 1 \(Office review\)/);
      await s.as(office);
      expect(await decide(s, r.id, "approved")).toMatchObject({ status: "pending", step: 2 });
      expect(await status(s, r.id)).toEqual({ status: "pending", approval_step: 2 });
      expect((await pgError(decide(s, r.id, "approved"))).message).toMatch(/waits for step 2 \(Owner\)/);
      await s.as(owner);
      expect((await decide(s, r.id, "approved")).status).toBe("approved");
      const kinds = await s.query<{ kind: string }>("select kind from public.time_off_events where request_id = $1 order by created_at", [r.id]);
      expect(kinds.rows.map((k) => k.kind)).toEqual(["submitted", "step_approved", "approved"]);
    });
  });

  it("a denial at any step ends the request; without a chain one approval decides; changing the chain restarts pending requests", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const owner2 = await s.createUser("owner");
      const driver = await s.createUser("driver");
      await employee(s, driver);
      await s.as(owner);
      await chain(s, [{ role: "owner", label: "First owner" }, { role: "owner", label: "Second owner" }]);
      await s.as(driver);
      const a = await save(s, { category: "personal", start_date: addDays(today, 5), end_date: addDays(today, 5) });
      const b = await save(s, { category: "personal", start_date: addDays(today, 6), end_date: addDays(today, 6) });
      await s.as(owner);
      expect((await decide(s, a.id, "denied")).status).toBe("denied");
      expect(await decide(s, b.id, "approved")).toMatchObject({ step: 2 });
      // A new chain restarts pending requests at step 1 (no request skips a new step).
      await chain(s, [{ role: "owner", label: "Owner" }]);
      expect((await status(s, b.id)).approval_step).toBe(1);
      await s.as(owner2);
      expect((await decide(s, b.id, "approved")).status).toBe("approved");
      // No chain: one approval, as before.
      await s.as(owner);
      await chain(s, []);
      await s.as(driver);
      const c = await save(s, { category: "personal", start_date: addDays(today, 7), end_date: addDays(today, 7) });
      await s.as(owner);
      expect((await decide(s, c.id, "approved")).status).toBe("approved");
    });
  });

  it("only settings.manage sets the chain; other companies' chains are invisible", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(chain(s, [{ role: "owner", label: "Owner" }]))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(chain(s, [{ role: "nobody", label: "x" }]))).message).toMatch(/needs a role/);
      await chain(s, [{ role: "owner", label: "Owner" }]);
      const other = await s.createCompany("Brookside Aggregates");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select 1 from public.time_off_approval_steps")).rowCount).toBe(0);
    });
  });
});
