// Accounts, onboarding and early access: access codes (hash only, expiry,
// revocation, uses, rate limits, service-role only), reservations, atomic and
// idempotent company creation, several companies per person with a switcher,
// invitations of existing accounts, owner-only Owner role, and isolation.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeAccessCode } from "@/lib/early-access";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;
const hash = (code: string) => createHash("sha256").update(normalizeAccessCode(code)).digest("hex");
const code = () => `TLT-${randomUUID().replace(/-/g, "").slice(0, 20).toUpperCase().replace(/[ILOU]/g, "7")}`;

async function asService(s: Session) {
  await s.asAdmin();
  await s.query("set local role service_role");
}
async function newCode(s: Session, opts: { uses?: number; expires?: string } = {}) {
  const c = code();
  await asService(s);
  const id = (await s.query<{ id: string }>("select public.early_access_create_code($1, 'Test code', $2, $3::timestamptz) as id", [hash(c), opts.uses ?? 1, opts.expires ?? new Date(Date.now() + 86400000).toISOString()])).rows[0].id;
  return { code: c, id };
}
const check = async (s: Session, c: string, ip = "ip-1", email = "email-1") => {
  await asService(s);
  return (await s.query<{ r: { ok: boolean; reason: string } }>("select public.early_access_check($1, $2, $3) as r", [hash(c), ip, email])).rows[0].r;
};
const reserve = async (s: Session, c: string, user: string, key = randomUUID(), name = "Ridgeway Aggregates (test)") => {
  await asService(s);
  return (await s.query<{ r: Row }>("select public.early_access_reserve($1, $2, $3, $4) as r", [hash(c), user, name, key])).rows[0].r;
};
async function verify(s: Session, user: string) {
  await s.asAdmin();
  await s.query("update auth.users set email_confirmed_at = now() where id = $1", [user]);
}

describe("early-access codes", () => {
  it("accept only a known, unexpired, unrevoked code with uses left, and never expose codes to app users", async () => {
    await withSession(async (s) => {
      const a = await newCode(s, { uses: 2 });
      expect(await check(s, a.code)).toEqual({ ok: true, reason: "ok" });
      expect(await check(s, a.code.toLowerCase().replace(/-/g, " "))).toEqual({ ok: true, reason: "ok" }); // normalized
      expect((await check(s, code())).reason).toBe("unknown");
      const old = await newCode(s);
      await s.asAdmin();
      await s.query("update private.early_access_codes set expires_at = now() - interval '1 minute' where id = $1", [old.id]);
      expect((await check(s, old.code)).reason).toBe("expired");
      const r = await newCode(s);
      await asService(s);
      await s.query("select public.early_access_revoke_code($1, 'Sent to the wrong person')", [r.id]);
      expect((await check(s, r.code)).reason).toBe("revoked");
      expect((await pgError(s.query("select public.early_access_revoke_code($1, '')", [r.id]))).message).toMatch(/reason/);

      // Uses: reservations count.
      const u1 = await s.createUser(null, { membership: false });
      const u2 = await s.createUser(null, { membership: false });
      const u3 = await s.createUser(null, { membership: false });
      expect(await reserve(s, a.code, u1)).toMatchObject({ ok: true, created: true });
      expect(await reserve(s, a.code, u2)).toMatchObject({ ok: true, created: true });
      expect(await reserve(s, a.code, u3)).toEqual({ ok: false, reason: "used_up" });
      expect((await check(s, a.code)).reason).toBe("used_up");

      // Only hashes are stored; the list never contains codes.
      await asService(s);
      const listed = JSON.stringify((await s.query("select * from public.early_access_list_codes()")).rows);
      expect(listed).not.toContain(a.code);
      await s.asAdmin();
      expect((await s.query("select 1 from private.early_access_codes where code_hash = $1", [hash(a.code)])).rowCount).toBe(1);

      // App users and anonymous callers cannot touch any of it.
      for (const role of ["owner", null] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        for (const sql of ["select public.early_access_check('x', 'y', 'z')", "select * from public.early_access_list_codes()", "select public.early_access_create_code('x', 'y', 1, now())", "select 1 from private.early_access_codes"]) {
          expect((await pgError(s.query(sql))).code, `${role} ${sql}`).toBe("42501");
        }
      }
      await s.as(null);
      expect((await pgError(s.query("select public.early_access_reserve('x', null, 'y', gen_random_uuid())"))).code).toBe("42501");
    });
  });

  it("rate limits failed attempts per email address and per IP address", async () => {
    await withSession(async (s) => {
      const good = await newCode(s, { uses: 5 });
      for (let i = 0; i < 5; i++) expect((await check(s, code(), `ip-${i}`, "victim")).reason).toBe("unknown");
      expect((await check(s, good.code, "ip-new", "victim")).reason).toBe("rate_limited"); // even a good code
      for (let i = 0; i < 10; i++) await check(s, code(), "busy-ip", `e-${i}`);
      expect((await check(s, good.code, "busy-ip", "fresh-email")).reason).toBe("rate_limited");
      expect((await check(s, good.code, "other-ip", "other-email")).ok).toBe(true);
    });
  });

  it("reservations are idempotent per request and one pending company per account", async () => {
    await withSession(async (s) => {
      const a = await newCode(s, { uses: 3 });
      const u = await s.createUser(null, { membership: false });
      const other = await s.createUser(null, { membership: false });
      const key = randomUUID();
      const first = await reserve(s, a.code, u, key);
      expect(await reserve(s, a.code, u, key)).toEqual({ ok: true, redemption_id: first.redemption_id, created: false });
      expect(await reserve(s, a.code, other, key)).toEqual({ ok: false, reason: "conflict" });
      expect(await reserve(s, a.code, u)).toEqual({ ok: false, reason: "pending" });
      expect(await reserve(s, a.code, other, randomUUID(), "x")).toEqual({ ok: false, reason: "company_name" });
      await asService(s);
      expect((await s.query<{ r: Row }>("select public.early_access_request($1) as r", [key])).rows[0].r).toEqual({ user_id: u, status: "reserved" });
    });
  });
});

describe("creating a company", () => {
  it("creates company, settings, numbering, permissions, units and the owner membership in one step, once", async () => {
    await withSession(async (s) => {
      const a = await newCode(s);
      const u = await s.createUser(null, { membership: false });
      await reserve(s, a.code, u, randomUUID(), "Ridgeway Aggregates (test)");

      await s.as(u);
      expect((await s.query<{ r: Row }>("select public.my_onboarding() as r")).rows[0].r).toEqual({ email_verified: false, pending_company: "Ridgeway Aggregates (test)", membership_count: 0 });
      expect((await pgError(s.query("select public.complete_company_onboarding(null)"))).message).toMatch(/Confirm your email/);
      await verify(s, u);
      await s.as(u);
      const r = (await s.query<{ r: { company_id: string; created: boolean; name: string } }>("select public.complete_company_onboarding('Ridgeway Aggregates LLC (test)') as r")).rows[0].r;
      expect(r).toMatchObject({ created: true, name: "Ridgeway Aggregates LLC (test)" });
      expect((await s.query<{ r: { company_id: string; created: boolean } }>("select public.complete_company_onboarding(null) as r")).rows[0].r).toMatchObject({ company_id: r.company_id, created: false });

      const access = (await s.query<{ r: Row }>("select public.my_access() as r")).rows[0].r;
      expect(access).toMatchObject({ company_id: r.company_id, role: "owner", company_name: "Ridgeway Aggregates LLC (test)" });
      expect((access.permissions as string[])).toContain("users.manage");

      await s.asAdmin();
      const counts = (await s.query<Row>(
        `select (select count(*)::int from public.company_settings where company_id = $1) as settings,
                (select count(*)::int from public.document_sequences where company_id = $1) as sequences,
                (select count(*)::int from public.units_of_measure where company_id = $1) as units,
                (select count(*)::int from public.price_lists where company_id = $1 and is_standard) as price_lists,
                (select count(*)::int from public.role_permissions where company_id = $1) as perms,
                (select count(*)::int from public.role_permission_defaults) as default_perms,
                (select count(*)::int from public.company_memberships where company_id = $1) as members,
                (select count(*)::int from public.audit_events where company_id = $1 and action = 'company.created') as audited`,
        [r.company_id],
      )).rows[0];
      expect(counts).toMatchObject({ settings: 1, sequences: 5, units: 7, price_lists: 1, members: 1, audited: 1 });
      expect(counts.perms).toBe(counts.default_perms);
      // Its own numbering starts at 1 and does not touch Top Line's.
      await s.as(u);
      const c = (await s.query<{ customer_number: string }>("insert into public.customers (name) values ('First customer (test)') returning customer_number")).rows[0];
      expect(c.customer_number).toBe("C-00001");
      expect((await s.query("select 1 from public.customers where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
    });
  });

  it("refuses a revoked code at completion and accounts without a reservation", async () => {
    await withSession(async (s) => {
      const a = await newCode(s);
      const u = await s.createUser(null, { membership: false });
      await reserve(s, a.code, u);
      await asService(s);
      await s.query("select public.early_access_revoke_code($1, 'Withdrawn')", [a.id]);
      await verify(s, u);
      await s.as(u);
      expect((await pgError(s.query("select public.complete_company_onboarding(null)"))).message).toMatch(/revoked/);
      const nobody = await s.createUser(null, { membership: false });
      await verify(s, nobody);
      await s.as(nobody);
      expect((await pgError(s.query("select public.complete_company_onboarding(null)"))).message).toMatch(/no company waiting/);
      await s.as(null);
      expect((await pgError(s.query("select public.complete_company_onboarding(null)"))).code).toBe("42501");
    });
  });

  it("an existing member creates another company with a code; data stays separate and the switcher only allows own companies", async () => {
    await withSession(async (s) => {
      const a = await newCode(s);
      const office = await s.createUser("office"); // Top Line
      await verify(s, office);
      await s.as(office);
      expect((await s.query("select 1 from public.customers where company_id = $1 limit 1", [TOP_LINE])).rowCount).toBe(1);
      const key = randomUUID();
      const bad = (await s.query<{ r: Row }>("select public.create_company_with_access_code($1, 'Side Hauling (test)', $2) as r", [hash(code()), randomUUID()])).rows[0].r;
      expect(bad).toEqual({ ok: false, reason: "unknown" });
      const r = (await s.query<{ r: { ok: boolean; company_id: string; created: boolean } }>("select public.create_company_with_access_code($1, 'Side Hauling (test)', $2) as r", [hash(a.code), key])).rows[0].r;
      expect(r).toMatchObject({ ok: true, created: true });
      expect((await s.query<{ r: Row }>("select public.create_company_with_access_code($1, 'Side Hauling (test)', $2) as r", [hash(a.code), key])).rows[0].r).toMatchObject({ company_id: r.company_id, created: false });

      // Now working in the new company: Top Line's data is invisible.
      expect((await s.query<{ r: Row }>("select public.my_access() as r")).rows[0].r).toMatchObject({ company_id: r.company_id, role: "owner" });
      expect((await s.query("select 1 from public.customers where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      const companies = (await s.query<{ company_id: string; role: string; current: boolean }>("select * from public.my_companies()")).rows;
      expect(companies.map((c) => [c.company_id, c.role, c.current]).sort()).toEqual([[TOP_LINE, "office", false], [r.company_id, "owner", true]].sort());

      // Switch back: Top Line again, as office.
      await s.query("select public.switch_company($1)", [TOP_LINE]);
      expect((await s.query<{ r: Row }>("select public.my_access() as r")).rows[0].r).toMatchObject({ company_id: TOP_LINE, role: "office" });
      expect((await s.query("select 1 from public.customers where company_id = $1", [r.company_id])).rowCount).toBe(0);

      // Not a member, or deactivated: refused.
      const B = await s.createCompany("Brookside Aggregates (test)");
      expect((await pgError(s.query("select public.switch_company($1)", [B]))).code).toBe("42501");
      await s.asAdmin();
      await s.query("update public.company_memberships set active = false where company_id = $1 and user_id = $2", [r.company_id, office]);
      await s.as(office);
      expect((await pgError(s.query("select public.switch_company($1)", [r.company_id]))).code).toBe("42501");
    });
  });

  it("rate limits company creation attempts per account", async () => {
    await withSession(async (s) => {
      const u = await s.createUser("office");
      await verify(s, u);
      await s.as(u);
      for (let i = 0; i < 5; i++) {
        expect((await s.query<{ r: Row }>("select public.create_company_with_access_code($1, 'Guess (test)', $2) as r", [hash(code()), randomUUID()])).rows[0].r).toMatchObject({ reason: "unknown" });
      }
      const good = await newCode(s);
      await s.as(u);
      expect((await s.query<{ r: Row }>("select public.create_company_with_access_code($1, 'Guess (test)', $2) as r", [hash(good.code), randomUUID()])).rows[0].r).toEqual({ ok: false, reason: "rate_limited" });
    });
  });
});

describe("invitations and roles", () => {
  it("adds an existing account to the company once, keeps deactivations, and reports unknown emails", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const B = await s.createCompany("Brookside Aggregates (test)");
      const bUser = await s.createUser("dispatcher", { companyId: B });
      const email = (await s.query<{ email: string }>("select email from public.profiles where id = $1", [bUser])).rows[0].email;

      await s.as(owner);
      const add = (role: string, e = email) => s.query<{ r: Row }>("select public.add_existing_member($1, $2, 'Dana (test)') as r", [e, role]).then((x) => x.rows[0].r);
      expect(await add("dispatcher", "nobody-here@test.example")).toEqual({ found: false });
      expect(await add("dispatcher", email.toUpperCase())).toMatchObject({ found: true, already: false, user_id: bUser });
      expect(await add("office")).toMatchObject({ found: true, already: true, role: "dispatcher" });
      expect((await s.query("select 1 from public.audit_events where action = 'member.added' and entity_id = $1", [bUser])).rowCount).toBe(1);

      // The person now has two companies; each shows only its own data.
      await s.as(bUser);
      expect((await s.query("select * from public.my_companies()")).rowCount).toBe(2);
      await s.query("select public.switch_company($1)", [B]);
      expect((await s.query<{ r: Row }>("select public.my_access() as r")).rows[0].r).toMatchObject({ company_id: B, role: "dispatcher" });
      expect((await s.query("select 1 from public.customers where company_id = $1", [TOP_LINE])).rowCount).toBe(0);
      await s.query("select public.switch_company($1)", [TOP_LINE]);
      expect((await s.query<{ r: Row }>("select public.my_access() as r")).rows[0].r).toMatchObject({ company_id: TOP_LINE, role: "dispatcher" });

      // Deactivated people are not silently re-added.
      await s.as(owner);
      await s.query("select public.set_user_access($1, 'dispatcher', false, 'Dana (test)')", [bUser]);
      expect((await pgError(add("dispatcher"))).message).toMatch(/deactivated/);

      // Without users.manage: refused.
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(add("office", "nobody@test.example"))).code).toBe("42501");
    });
  });

  it("only an owner can grant or remove the Owner role, even when office has users.manage", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const target = await s.createUser("dispatcher");
      await s.as(owner);
      await s.query("select public.set_role_permission('office', 'users.manage', true)");
      await s.as(office);
      expect((await pgError(s.query("select public.set_user_access($1, 'owner', true, 'Target (test)')", [target]))).code).toBe("42501");
      expect((await pgError(s.query("select public.set_user_access($1, 'office', true, 'Owner (test)')", [owner]))).code).toBe("42501");
      expect((await pgError(s.query("select public.add_existing_member('x@test.example', 'owner', 'X')"))).code).toBe("42501");
      expect((await pgError(s.query("select public.add_company_member($1, 'owner', 'X')", [randomUUID()]))).code).toBe("42501");
      await s.query("select public.set_user_access($1, 'mechanic', true, 'Target (test)')", [target]); // other roles still fine
      await s.as(owner);
      await s.query("select public.set_user_access($1, 'owner', true, 'Target (test)')", [target]);
      expect((await s.query("select role from public.company_memberships where user_id = $1 and company_id = $2", [target, TOP_LINE])).rows[0].role).toBe("owner");
    });
  });
});

describe("concurrency", () => {
  it("two sign-ups racing for the last use of a code: one wins", async () => {
    const c = code();
    const setup = await pool.connect();
    const users = [randomUUID(), randomUUID()];
    let codeId = "";
    try {
      await setup.query("begin");
      codeId = (await setup.query("select public.early_access_create_code($1, 'Race (test)', 1, now() + interval '1 day') as id", [hash(c)])).rows[0].id;
      for (const u of users) await setup.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [u, `race-${u.slice(0, 8)}@test.example`]);
      await setup.query("commit");
    } finally {
      setup.release();
    }
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("begin");
      await b.query("begin");
      const ra = await a.query("select public.early_access_reserve($1, $2, 'Race A (test)', gen_random_uuid()) as r", [hash(c), users[0]]);
      const pb = b.query("select public.early_access_reserve($1, $2, 'Race B (test)', gen_random_uuid()) as r", [hash(c), users[1]]);
      await new Promise((r) => setTimeout(r, 300)); // b waits on the code's row lock
      await a.query("commit");
      const rb = await pb;
      await b.query("commit");
      expect(ra.rows[0].r).toMatchObject({ ok: true });
      expect(rb.rows[0].r).toEqual({ ok: false, reason: "used_up" });
    } finally {
      a.release();
      b.release();
      const c2 = await pool.connect();
      await c2.query("delete from auth.users where id = any($1)", [users]); // cascades the reservation
      await c2.query("delete from private.early_access_codes where id = $1", [codeId]);
      c2.release();
    }
  });
});
