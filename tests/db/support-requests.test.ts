// Support change requests (SA2, migration 20261120009200): during a visit, staff ask an owner to approve a people or
// sign-in change instead of making it; only a real owner approves (exactly once) or declines; the asker can withdraw;
// requests expire; every step is audited; the stored form is never listed.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function supportStaff(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  await s.query("update private.platform_admins set level = 'support' where user_id = $1", [id]);
  return id;
}

async function visit(s: Session) {
  const company = await s.createCompany(`Request Haul ${randomUUID().slice(0, 6)} (test)`);
  await s.asAdmin();
  await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [company]);
  const owner = await s.createUser("owner", { companyId: company });
  const dispatcher = await s.createUser("dispatcher", { companyId: company });
  const sup = await supportStaff(s);
  await s.as(owner);
  await s.query("select public.support_access_grant(3)");
  await s.as(sup);
  await s.query("select public.platform_support_enter($1, 'Add a driver')", [company]);
  return { company, owner, dispatcher, sup };
}

type Req = { id: string; status: string; summary: string; requested_by: string; mine: boolean; result: string; payload?: unknown };
const list = async (s: Session) => (await s.query<{ r: Req[] }>("select public.support_change_requests() r")).rows[0].r;
const ask = async (s: Session, summary = "Change Dana Dispatch to Office") =>
  (await s.query<{ id: string }>("select public.support_change_request('people.access', $1, $2, $3, 'They asked by phone') id",
    [JSON.stringify(["u", { $form: [["role", "office"]] }]), summary, JSON.stringify([{ label: "Role", value: "Office" }])])).rows[0].id;

describe("support change requests", () => {
  it("staff ask during a visit; the owner sees it (without the form) and approves it exactly once", async () => {
    await withSession(async (s) => {
      const { company, owner, dispatcher, sup } = await visit(s);
      const id = await ask(s);
      const mine = await list(s);
      expect(mine[0]).toMatchObject({ id, status: "pending", mine: true, summary: "Change Dana Dispatch to Office" });
      expect(mine[0].payload).toBeUndefined();
      expect((await s.query<{ a: { support_requests: number } }>("select public.my_access() a")).rows[0].a.support_requests).toBe(1);
      // Staff cannot approve or decline their own request.
      expect((await pgError(s.query("select public.support_change_claim($1)", [id]))).code).toBe("42501");
      expect((await pgError(s.query("select public.support_change_decline($1)", [id]))).code).toBe("42501");

      // A dispatcher cannot see or approve it.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.support_change_requests()"))).code).toBe("42501");
      expect((await pgError(s.query("select public.support_change_claim($1)", [id]))).code).toBe("42501");
      expect((await s.query<{ a: { support_requests: number } }>("select public.my_access() a")).rows[0].a.support_requests).toBe(0);

      await s.as(owner);
      expect((await s.query<{ a: { support_requests: number } }>("select public.my_access() a")).rows[0].a.support_requests).toBe(1);
      const [r] = await list(s);
      expect(r.requested_by).toMatch(/\(Taviron support\)$/);
      expect(r.mine).toBe(false);
      const claim = (await s.query<{ c: { kind: string; payload: unknown } }>("select public.support_change_claim($1) c", [id])).rows[0].c;
      expect(claim.kind).toBe("people.access");
      expect(claim.payload).toEqual(["u", { $form: [["role", "office"]] }]);
      // Never twice.
      expect((await pgError(s.query("select public.support_change_claim($1)", [id]))).message).toMatch(/no longer waiting/);
      await s.query("select public.support_change_finish($1, true, 'User updated.')", [id]);
      expect((await list(s))[0]).toMatchObject({ status: "done", result: "User updated." });
      // Only the approver records the result, once.
      await s.query("select public.support_change_finish($1, false, 'again')", [id]);
      expect((await list(s))[0].status).toBe("done");

      const audit = (await s.query<{ action: string }>("select action from public.audit_events where company_id = $1 and action like 'support_request.%'", [company])).rows.map((x) => x.action);
      expect(audit).toEqual(expect.arrayContaining(["support_request.created", "support_request.approved"]));
      expect(sup).toBeTruthy();
    });
  });

  it("only during a visit; declined, withdrawn and expired requests cannot be approved", async () => {
    await withSession(async (s) => {
      const { owner, sup } = await visit(s);
      const a = await ask(s, "Add Pat Driver as Driver");
      const b = await ask(s, "Reset Pat Driver's password");
      await s.query("select public.support_change_withdraw($1)", [b]);
      // The owner cannot make a request.
      await s.as(owner);
      expect((await pgError(ask(s))).code).toBe("42501");
      await s.query("select public.support_change_decline($1)", [a]);
      expect((await pgError(s.query("select public.support_change_claim($1)", [a]))).message).toMatch(/no longer waiting/);
      expect((await pgError(s.query("select public.support_change_claim($1)", [b]))).message).toMatch(/no longer waiting/);
      const statuses = Object.fromEntries((await list(s)).map((x) => [x.id, x.status]));
      expect(statuses).toEqual({ [a]: "declined", [b]: "withdrawn" });

      await s.as(sup);
      const c = await ask(s, "Turn on two-step");
      await s.asAdmin();
      await s.query("update private.support_change_requests set expires_at = now() - interval '1 minute' where id = $1", [c]);
      await s.as(owner);
      expect((await list(s)).find((x) => x.id === c)?.status).toBe("expired");
      expect((await pgError(s.query("select public.support_change_claim($1)", [c]))).message).toMatch(/no longer waiting/);

      // After leaving, staff can no longer ask.
      await s.as(sup);
      await s.query("select public.platform_support_leave()");
      expect((await pgError(ask(s))).code).toBe("42501");
    });
  });

  it("another company's owner never sees or approves a request", async () => {
    await withSession(async (s) => {
      const { sup } = await visit(s);
      const id = await ask(s);
      await s.asAdmin();
      const other = await s.createUser("owner");
      expect(other).not.toBe(sup);
      await s.as(other);
      expect((await list(s)).map((x) => x.id)).not.toContain(id);
      expect((await pgError(s.query("select public.support_change_claim($1)", [id]))).message).toMatch(/no longer waiting/);
      expect((await pgError(s.query("select public.support_change_decline($1)", [id]))).message).toMatch(/no longer waiting/);
    });
  });
});
