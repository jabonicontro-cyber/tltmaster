// Adding someone who already has a sign-in needs their consent (security review 2026-11-06, M1; migration
// 20261120009100): an invitation, not a membership; nothing about them is readable until they accept; they accept or
// decline; the company can withdraw; add_company_member cannot attach an existing account by its id.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, TOP_LINE } from "./helpers";

afterAll(() => pool.end());

describe("membership invitations", () => {
  it("an existing sign-in is invited, not added; the company sees nothing about them until they accept", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany(`Other Haul ${randomUUID().slice(0, 6)} (test)`);
      const person = await s.createUser("dispatcher", { companyId: other });
      await s.asAdmin();
      const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [person])).rows[0].email;
      await s.query("update public.profiles set phone = '555-0199' where id = $1", [person]);
      const owner = await s.createUser("owner");
      await s.query("insert into public.employees (company_id, full_name, work_email, status) values ($1, 'Pat Two-Company', $2, 'active')", [TOP_LINE, email]);

      await s.as(owner);
      const r = (await s.query<{ r: Record<string, unknown> }>("select public.add_existing_member($1, 'dispatcher', 'Pat Two-Company') r", [email])).rows[0].r;
      expect(r).toEqual({ found: true, already: false, invited: true });
      expect(r).not.toHaveProperty("user_id");
      // Not a member, profile not readable.
      expect((await s.query("select 1 from public.company_memberships where user_id = $1", [person])).rowCount).toBe(0);
      expect((await s.query("select phone from public.profiles where id = $1", [person])).rowCount).toBe(0);
      const waiting = (await s.query<{ email: string; role: string }>("select email, role::text from public.company_membership_invitations()")).rows;
      expect(waiting).toEqual([expect.objectContaining({ email, role: "dispatcher" })]);
      // A second invite refreshes the waiting one.
      await s.query("select public.add_existing_member($1, 'office', 'Pat Two-Company')", [email]);
      expect((await s.query("select 1 from public.company_membership_invitations()")).rowCount).toBe(1);

      // The person sees it and accepts: a membership with the invited role, linked to the person record.
      await s.as(person);
      const mine = (await s.query<{ id: string; company_name: string; role: string }>("select id, company_name, role::text from public.my_membership_invitations()")).rows;
      expect(mine).toHaveLength(1);
      expect(mine[0].role).toBe("office");
      const company = (await s.query<{ c: string }>("select public.answer_membership_invitation($1, true) c", [mine[0].id])).rows[0].c;
      expect(company).toBe(TOP_LINE);
      await s.asAdmin();
      expect((await s.query<{ role: string; active: boolean }>("select role::text, active from public.company_memberships where user_id = $1 and company_id = $2", [person, TOP_LINE])).rows[0]).toEqual({ role: "office", active: true });
      expect((await s.query("select 1 from public.employees where company_id = $1 and user_id = $2", [TOP_LINE, person])).rowCount).toBe(1);
      await s.as(person);
      expect((await pgError(s.query("select public.answer_membership_invitation($1, true)", [mine[0].id]))).code).toBe("P0002");
    });
  });

  it("declining, withdrawing, and only the invited person can answer", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany(`Other Haul ${randomUUID().slice(0, 6)} (test)`);
      const person = await s.createUser("driver", { companyId: other });
      const stranger = await s.createUser("driver", { companyId: other });
      await s.asAdmin();
      const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [person])).rows[0].email;
      const owner = await s.createUser("owner");
      await s.as(owner);
      await s.query("select public.add_existing_member($1, 'driver', '')", [email]);
      const id = (await s.query<{ id: string }>("select id from public.company_membership_invitations()")).rows[0].id;
      await s.as(stranger);
      expect((await pgError(s.query("select public.answer_membership_invitation($1, true)", [id]))).code).toBe("P0002");
      await s.as(owner);
      await s.query("select public.withdraw_membership_invitation($1)", [id]);
      await s.as(person);
      expect((await s.query("select 1 from public.my_membership_invitations()")).rowCount).toBe(0);
      await s.as(owner);
      await s.query("select public.add_existing_member($1, 'driver', '')", [email]);
      await s.as(person);
      const again = (await s.query<{ id: string }>("select id from public.my_membership_invitations()")).rows[0].id;
      expect((await s.query<{ c: string | null }>("select public.answer_membership_invitation($1, false) c", [again])).rows[0].c).toBeNull();
      await s.asAdmin();
      expect((await s.query("select 1 from public.company_memberships where user_id = $1 and company_id = $2", [person, TOP_LINE])).rowCount).toBe(0);
    });
  });

  it("add_company_member accepts only a brand-new sign-in in no company", async () => {
    await withSession(async (s) => {
      const other = await s.createCompany(`Other Haul ${randomUUID().slice(0, 6)} (test)`);
      const existing = await s.createUser("driver", { companyId: other });
      const fresh = await s.createUser(null, { membership: false });
      const old = await s.createUser(null, { membership: false });
      await s.asAdmin();
      // Auth sets created_at on every sign-in it creates (the test inserts users directly).
      await s.query("update auth.users set created_at = now() where id = $1", [fresh]);
      await s.query("update auth.users set created_at = now() - interval '2 hours' where id = $1", [old]);
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.add_company_member($1, 'driver', 'X')", [existing]))).message).toMatch(/User not found/);
      expect((await pgError(s.query("select public.add_company_member($1, 'driver', 'X')", [old]))).message).toMatch(/User not found/);
      await s.query("select public.add_company_member($1, 'driver', 'New Driver')", [fresh]);
      // A retry says so plainly.
      expect((await pgError(s.query("select public.add_company_member($1, 'driver', 'New Driver')", [fresh]))).message).toMatch(/already a member/);
      // A sign-in this company provisioned (username sign-ins) is accepted whenever it was made.
      await s.asAdmin();
      await s.query("insert into private.account_provisions (request_key, company_id, kind, username, user_id) values (gen_random_uuid(), $1, 'employee', $2, $3)", [TOP_LINE, `old-${old.slice(0, 8)}`, old]);
      await s.as(owner);
      await s.query("select public.add_company_member($1, 'driver', 'Old Driver')", [old]);
      await s.asAdmin();
      expect((await s.query("select 1 from public.company_memberships where user_id = $1 and company_id = $2", [fresh, TOP_LINE])).rowCount).toBe(1);
    });
  });
});
