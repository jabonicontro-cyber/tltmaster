// Early-access site gate at the database layer (N12): site codes and company
// sign-up codes never stand in for each other; redeeming creates one grant per
// device up to the code's limit; failed attempts are rate limited per address;
// revoking a code or its devices ends their grants; changes are audited; and
// only the service role can do any of it. Passing the gate creates no account,
// company, membership or permission.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const hash = (c: string) => createHash("sha256").update(c).digest("hex");
const code = () => `TLT${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase()}`;
const asService = (s: Session) => s.query("set local role service_role");
const create = async (s: Session, c: string, purpose: "site_access" | "company_signup", uses = 3, days = 1) =>
  (await s.query<{ id: string }>("select public.early_access_create_code($1, 'Gate test', $2, now() + make_interval(days => $3), $4) as id", [hash(c), uses, days, purpose])).rows[0].id;
const redeem = async (s: Session, c: string, ip = `ip-${randomUUID()}`) =>
  (await s.query<{ r: { ok: boolean; reason?: string; grant_id?: string; expires_at?: string } }>("select public.site_access_redeem($1, $2, 30) as r", [hash(c), ip])).rows[0].r;
const validate = async (s: Session, g: string) => (await s.query<{ r: { valid: boolean; reason?: string } }>("select public.site_access_validate($1) as r", [g])).rows[0].r;

describe("early-access site gate", () => {
  it("admits devices with a site code only; company codes and site codes never stand in for each other", async () => {
    await withSession(async (s) => {
      await asService(s);
      const site = code();
      const company = code();
      await create(s, site, "site_access", 2);
      await create(s, company, "company_signup", 1);
      const counts = async () => {
        await s.query("reset role");
        const r = (await s.query<{ u: number; m: number; c: number; p: number }>("select (select count(*)::int from auth.users) u, (select count(*)::int from public.company_memberships) m, (select count(*)::int from public.companies) c, (select count(*)::int from public.role_permissions) p")).rows[0];
        await asService(s);
        return r;
      };
      const before = await counts();

      const a = await redeem(s, site);
      expect(a).toMatchObject({ ok: true });
      expect(new Date(a.expires_at!).getTime()).toBeLessThanOrEqual(Date.now() + 86400_000 + 5000); // never beyond the code's expiry
      expect((await validate(s, a.grant_id!)).valid).toBe(true);
      expect(await redeem(s, company)).toEqual({ ok: false, reason: "unknown" }); // a sign-up code does not open the gate
      expect((await s.query<{ r: { ok: boolean; reason: string } }>("select public.early_access_check($1, 'x', 'y') as r", [hash(site)])).rows[0].r).toEqual({ ok: false, reason: "unknown" }); // and vice versa
      // Device limit.
      expect((await redeem(s, site)).ok).toBe(true);
      expect(await redeem(s, site)).toEqual({ ok: false, reason: "used_up" });
      // Nothing else was created.
      expect(await counts()).toEqual(before);
    });
  });

  it("limits failed attempts per address and never reveals partial matches", async () => {
    await withSession(async (s) => {
      await asService(s);
      const site = code();
      await create(s, site, "site_access", 5);
      const ip = `ip-${randomUUID()}`;
      const almost = site.slice(0, -1) + (site.endsWith("0") ? "1" : "0");
      expect(await redeem(s, almost, ip)).toEqual({ ok: false, reason: "unknown" });
      for (let i = 0; i < 9; i++) await redeem(s, code(), ip);
      expect(await redeem(s, site, ip)).toEqual({ ok: false, reason: "rate_limited" }); // even the right code
      expect((await redeem(s, site)).ok).toBe(true); // another address is unaffected
      // Only keyed hashes are stored, never the code or the address.
      await s.query("reset role");
      expect((await s.query("select 1 from private.access_attempts where key_hash = $1 or key_hash = $2", [site, almost])).rowCount).toBe(0);
    });
  });

  it("revoking a code or its devices ends access; expiry ends it too; every change is audited", async () => {
    await withSession(async (s) => {
      await asService(s);
      const site = code();
      const id = await create(s, site, "site_access", 10);
      const g1 = (await redeem(s, site)).grant_id!;
      const g2 = (await redeem(s, site)).grant_id!;
      expect((await s.query<{ n: number }>("select public.site_access_revoke_grants($1, 'Shared too widely') as n", [id])).rows[0].n).toBe(2);
      expect(await validate(s, g1)).toEqual({ valid: false, reason: "revoked" });
      const g3 = (await redeem(s, site)).grant_id!; // the code itself still admits new devices
      expect((await validate(s, g3)).valid).toBe(true);
      await s.query("select public.early_access_revoke_code($1, 'Rotated')", [id]);
      expect(await validate(s, g3)).toEqual({ valid: false, reason: "revoked" });
      expect(await redeem(s, site)).toEqual({ ok: false, reason: "revoked" });
      expect(await validate(s, randomUUID())).toEqual({ valid: false, reason: "unknown" });

      // Expiry (aged in setup only).
      const site2 = code();
      await create(s, site2, "site_access", 5);
      const g4 = (await redeem(s, site2)).grant_id!;
      await s.query("reset role");
      await s.query("update private.site_access_grants set expires_at = now() - interval '1 second', created_at = now() - interval '1 day' where id = $1", [g4]);
      await asService(s);
      expect(await validate(s, g4)).toEqual({ valid: false, reason: "expired" });

      await s.query("reset role");
      const audit = await s.query<{ action: string }>("select action from private.early_access_audit where code_id = $1 order by occurred_at, action", [id]);
      expect(audit.rows.map((r) => r.action).sort()).toEqual(["code_created", "code_revoked", "grants_revoked"]);
      const list = (await s.query<{ purpose: string; used: number; active_grants: number }>("select purpose, used, active_grants from public.early_access_list_codes() where id = $1", [id])).rows[0];
      expect(list).toEqual({ purpose: "site_access", used: 3, active_grants: 0 });
    });
  });

  it("only the service role can create, list, redeem, validate or revoke; app users and anonymous visitors cannot", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      for (const who of [owner, null]) {
        await s.as(who);
        for (const sql of [
          "select public.site_access_redeem('x', 'y', 30)",
          `select public.site_access_validate('${randomUUID()}')`,
          `select public.site_access_revoke_grants('${randomUUID()}', 'x')`,
          "select public.early_access_create_code('x', 'y', 1, now() + interval '1 day', 'site_access')",
          "select * from public.early_access_list_codes()",
          "select 1 from private.site_access_grants",
          "select 1 from private.early_access_audit",
        ]) {
          expect((await pgError(s.query(sql))).code, sql).toBe("42501");
        }
      }
    });
  });
});
