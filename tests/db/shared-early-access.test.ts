// Shared Early Access password at the database layer. The app verifies the
// password and sends only a keyed fingerprint; each device still gets its own
// revocable grant; the rate limit applies before a correct password; a new
// password retires the old one and its devices; revoking the password's record
// is a kill switch; and only the service role can do any of it.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type R = { ok: boolean; reason?: string; grant_id?: string; expires_at?: string };
const fp = () => randomBytes(32).toString("hex");
const asService = (s: Session) => s.query("set local role service_role");
const enter = async (s: Session, f: string, ip = `ip-${randomUUID()}`, max = 500) =>
  (await s.query<{ r: R }>("select public.site_access_enter_shared($1, $2, 30, $3) as r", [f, ip, max])).rows[0].r;
const validate = async (s: Session, g: string) => (await s.query<{ r: { valid: boolean; reason?: string } }>("select public.site_access_validate($1) as r", [g])).rows[0].r;

describe("shared early-access password", () => {
  it("gives every device its own grant and creates nothing else", async () => {
    await withSession(async (s) => {
      await s.query("reset role");
      const count = async () => (await s.query<{ n: string }>("select (select count(*) from auth.users) + (select count(*) from public.company_memberships) + (select count(*) from public.companies) as n")).rows[0].n;
      const before = await count();
      await asService(s);
      const f = fp();
      const a = await enter(s, f);
      const b = await enter(s, f);
      expect(a.ok && b.ok).toBe(true);
      expect(a.grant_id).not.toBe(b.grant_id);
      expect((await validate(s, a.grant_id!)).valid).toBe(true);
      // One device leaves; the other keeps access.
      expect((await s.query<{ r: boolean }>("select public.site_access_revoke_grant($1, 'Left early access') as r", [a.grant_id])).rows[0].r).toBe(true);
      expect(await validate(s, a.grant_id!)).toMatchObject({ valid: false, reason: "revoked" });
      expect((await validate(s, b.grant_id!)).valid).toBe(true);
      await s.query("reset role");
      expect(await count()).toBe(before);
    });
  });

  it("the password's record never works as a site code", async () => {
    await withSession(async (s) => {
      await asService(s);
      const f = fp();
      expect((await enter(s, f)).ok).toBe(true);
      expect((await s.query<{ r: R }>("select public.site_access_redeem($1, 'ip-x', 30) as r", [f])).rows[0].r).toEqual({ ok: false, reason: "unknown" });
    });
  });

  it("checks the rate limit before a correct password", async () => {
    await withSession(async (s) => {
      await asService(s);
      const ip = `ip-${randomUUID()}`;
      for (let i = 0; i < 10; i++) await s.query("select public.site_access_redeem($1, $2, 30)", ["0".repeat(64), ip]);
      expect(await enter(s, fp(), ip)).toEqual({ ok: false, reason: "rate_limited" });
      expect((await enter(s, fp())).ok).toBe(true); // other addresses are unaffected
    });
  });

  it("a new password retires the old one and its devices; revoking the record is a kill switch", async () => {
    await withSession(async (s) => {
      await asService(s);
      const oldF = fp();
      const old = await enter(s, oldF);
      const newF = fp();
      const fresh = await enter(s, newF);
      expect(fresh.ok).toBe(true);
      expect(await validate(s, old.grant_id!)).toMatchObject({ valid: false });
      expect(await enter(s, oldF)).toEqual({ ok: false, reason: "revoked" }); // the old password stays retired
      const [{ id }] = (await s.query<{ id: string }>("select id from public.early_access_list_codes() where purpose = 'site_shared' and revoked_at is null")).rows;
      await s.query("select public.early_access_revoke_code($1, 'Kill switch')", [id]);
      expect(await validate(s, fresh.grant_id!)).toMatchObject({ valid: false });
      expect(await enter(s, newF)).toEqual({ ok: false, reason: "revoked" });
    });
  });

  it("caps the devices admitted at the same time", async () => {
    await withSession(async (s) => {
      await asService(s);
      const f = fp();
      const a = await enter(s, f, undefined, 2);
      expect((await enter(s, f, undefined, 2)).ok).toBe(true);
      expect(await enter(s, f, undefined, 2)).toEqual({ ok: false, reason: "used_up" });
      await s.query("select public.site_access_revoke_grant($1, 'Left')", [a.grant_id]);
      expect((await enter(s, f, undefined, 2)).ok).toBe(true); // a freed place can be used again
    });
  });

  it("only the service role can use it", async () => {
    for (const role of ["anon", "authenticated"]) {
      await withSession(async (s) => {
        await s.query(`set local role ${role}`);
        expect(await pgError(s.query("select public.site_access_enter_shared($1, 'ip', 30, 5)", [fp()]))).toMatchObject({ message: expect.stringMatching(/permission denied/) });
      });
      await withSession(async (s) => {
        await s.query(`set local role ${role}`);
        expect(await pgError(s.query("select public.site_access_revoke_grant($1, 'x')", [randomUUID()]))).toMatchObject({ message: expect.stringMatching(/permission denied/) });
      });
    }
  });
});
