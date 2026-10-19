// Account provisioning (20261120001200; docs/ACCOUNT_PROVISIONING.md): username sign-ins for employees and customer-portal
// contacts. Reservations are unique and idempotent per request key; only staff with the right permission in the same
// company act; setup is required until the stored password actually changed; expired, reissued, demo, cross-company and
// escalation cases are refused; portal logins stay within one customer and never become memberships.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, sampleIds, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const uname = (prefix = "t") => `${prefix}-${randomUUID().slice(0, 8)}`;

/** What the server does with the Auth admin API: an Auth user at the username's internal address. */
async function authUser(s: Session, username: string, hash = "temp-hash-1"): Promise<string> {
  const id = randomUUID();
  await s.asAdmin();
  await s.query("insert into auth.users (id, email, aud, role, encrypted_password) values ($1, $2, 'authenticated', 'authenticated', $3)", [id, `${username}@users.mytaviron.com`, hash]);
  return id;
}

/** Reserve + create + attach as the given staff member (returns the new user's id). */
async function provision(s: Session, staff: string, kind: "employee" | "portal", username: string): Promise<{ user: string; key: string }> {
  const key = randomUUID();
  await s.as(staff);
  await s.query("select public.account_provision_begin($1, $2, $3)", [key, kind, username]);
  const user = await authUser(s, username);
  await s.as(staff);
  await s.query("select public.account_provision_attach($1, $2)", [key, user]);
  return { user, key };
}

async function employee(s: Session, owner: string, role = "driver", company = TOP_LINE) {
  const username = uname();
  const { user, key } = await provision(s, owner, "employee", username);
  await s.asAdmin();
  await s.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, $3, true)", [company, user, role]);
  await s.as(owner);
  await s.query("select public.account_setup_issue($1, 'employee', 168, 'print')", [user]);
  return { user, key, username };
}

async function openPortal(s: Session, company: string) {
  await s.asAdmin();
  await s.query("insert into private.portal_entitlements (company_id, entitled) values ($1, true) on conflict (company_id) do update set entitled = true", [company]);
  await s.query("insert into public.portal_settings (company_id, enabled) values ($1, true) on conflict (company_id) do update set enabled = true", [company]);
}

const companyOf = async (s: Session, user: string) => (await s.as(user), (await s.query<{ c: string | null }>("select private.current_company_id() c")).rows[0].c);

describe("account provisioning", () => {
  it("employee: reserved, attached and issued; no company until the password really changed; audit holds no secret", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { user, username } = await employee(s, owner);
      expect(await companyOf(s, user)).toBeNull();
      const setup = (await s.query<{ r: { required: boolean; kind: string; username: string } }>("select public.my_account_setup() r")).rows[0].r;
      expect(setup).toMatchObject({ required: true, kind: "employee", username });
      // Same stored password: refused.
      expect((await pgError(s.query("select public.account_setup_complete()"))).code).toBe("22023");
      await s.asAdmin();
      await s.query("update auth.users set encrypted_password = 'own-hash-2' where id = $1", [user]);
      await s.as(user);
      await s.query("select public.account_setup_complete()");
      expect(await companyOf(s, user)).toBe(TOP_LINE);
      await s.asAdmin();
      const events = (await s.query<{ action: string; details: string }>("select action, details::text from public.audit_events where entity_id = $1 order by occurred_at", [user])).rows;
      expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["account.setup_issued", "account.setup_completed"]));
      for (const e of events) expect(e.details).not.toMatch(/hash|password/i);
    });
  });

  it("usernames are unique and validated; a request key resumes and cannot be reused for something else", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const username = uname("dup");
      const key = randomUUID();
      await s.as(owner);
      await s.query("select public.account_provision_begin($1, 'employee', $2)", [key, username]);
      expect((await s.query<{ r: { available: boolean } }>("select public.account_username_available($1, 'employee') r", [username])).rows[0].r.available).toBe(false);
      expect((await pgError(s.query("select public.account_provision_begin($1, 'employee', $2)", [randomUUID(), username]))).code).toBe("23505");
      expect((await pgError(s.query("select public.account_provision_begin($1, 'portal', $2)", [randomUUID(), username.toUpperCase()]))).code).toBe("23505");
      expect((await pgError(s.query("select public.account_provision_begin($1, 'employee', 'a b')", [randomUUID()]))).code).toBe("22023");
      expect((await s.query<{ r: { resumed: boolean } }>("select public.account_provision_begin($1, 'employee', $2) r", [key, username])).rows[0].r.resumed).toBe(true);
      expect((await pgError(s.query("select public.account_provision_begin($1, 'employee', $2)", [key, uname()]))).code).toBe("42501");
      // An existing Auth user with that address also makes it taken.
      const existing = uname("auth");
      await authUser(s, existing);
      await s.as(owner);
      expect((await pgError(s.query("select public.account_provision_begin($1, 'employee', $2)", [randomUUID(), existing]))).code).toBe("23505");
      // Attaching a user whose address is not the reserved one is refused.
      const other = await authUser(s, uname("x"));
      await s.as(owner);
      expect((await pgError(s.query("select public.account_provision_attach($1, $2)", [key, other]))).code).toBe("42501");
    });
  });

  it("only staff with users.manage / customers.edit in their own company act, never in a demo", async () => {
    await withSession(async (s) => {
      const driver = await s.createUser("driver");
      await s.as(driver);
      expect((await pgError(s.query("select public.account_provision_begin($1, 'employee', $2)", [randomUUID(), uname()]))).code).toBe("42501");
      expect((await pgError(s.query("select public.account_provision_begin($1, 'portal', $2)", [randomUUID(), uname()]))).code).toBe("42501");
      expect((await pgError(s.query("select public.company_account_states('employee')"))).code).toBe("42501");
      await s.as(null);
      expect((await pgError(s.query("select public.account_username_available('someone', 'employee')"))).code).toBe("42501");
      // Demo company owner.
      const demo = await s.createCompany(`Demo ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      const demoOwner = await s.createUser("owner", { companyId: demo });
      await s.as(demoOwner);
      expect((await pgError(s.query("select public.account_provision_begin($1, 'employee', $2)", [randomUUID(), uname()]))).code).toBe("42501");
    });
  });

  it("credentials are never issued for oneself, email accounts, other companies, shared or platform accounts", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { user } = await employee(s, owner);
      await s.as(owner);
      expect((await pgError(s.query("select public.account_setup_check($1, 'employee')", [owner]))).code).toBe("42501");
      const emailPerson = await s.createUser("driver");
      await s.as(owner);
      expect((await pgError(s.query("select public.account_setup_check($1, 'employee')", [emailPerson]))).code).toBe("42501");
      // Another company's owner cannot touch Top Line's sign-in.
      const other = await s.createCompany(`Other ${randomUUID().slice(0, 6)}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.account_setup_check($1, 'employee')", [user]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.account_events($1, 'employee')", [user]))).code).toBe("P0002");
      expect((await s.query<{ r: boolean }>("select public.account_block_allowed($1, 'employee') r", [user])).rows[0].r).toBe(false);
      // Also a member elsewhere: not reset from here.
      await s.asAdmin();
      await s.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'driver', true)", [other, user]);
      await s.as(owner);
      expect((await pgError(s.query("select public.account_setup_check($1, 'employee')", [user]))).code).toBe("42501");
      expect((await s.query<{ r: boolean }>("select public.account_block_allowed($1, 'employee') r", [user])).rows[0].r).toBe(false);
    });
  });

  it("an expired temporary sign-in cannot be completed; a reissue starts setup again and keeps history", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { user } = await employee(s, owner);
      await s.asAdmin();
      await s.query("update private.account_setups set expires_at = now() - interval '1 minute' where user_id = $1", [user]);
      await s.query("update auth.users set encrypted_password = 'own-hash-2' where id = $1", [user]);
      await s.as(user);
      expect((await s.query<{ r: { expired: boolean } }>("select public.my_account_setup() r")).rows[0].r.expired).toBe(true);
      expect((await pgError(s.query("select public.account_setup_complete()"))).code).toBe("22023");
      expect(await companyOf(s, user)).toBeNull();
      // Reissue (the server set a new temporary password first).
      await s.asAdmin();
      await s.query("update auth.users set encrypted_password = 'temp-hash-3' where id = $1", [user]);
      await s.as(owner);
      expect((await s.query<{ r: { issue: number } }>("select public.account_setup_issue($1, 'employee', 168, 'reset') r", [user])).rows[0].r.issue).toBe(2);
      await s.asAdmin();
      await s.query("update auth.users set encrypted_password = 'own-hash-4' where id = $1", [user]);
      await s.as(user);
      await s.query("select public.account_setup_complete()");
      expect(await companyOf(s, user)).toBe(TOP_LINE);
      // A completed sign-in reset again is gated again.
      await s.as(owner);
      await s.query("select public.account_setup_issue($1, 'employee', 1, 'reset')", [user]);
      expect(await companyOf(s, user)).toBeNull();
      await s.asAdmin();
      const actions = (await s.query<{ action: string }>("select action from public.audit_events where entity_id = $1", [user])).rows.map((r) => r.action);
      expect(actions.filter((a) => a === "account.setup_reissued").length).toBe(2);
    });
  });

  it("an off sign-in may be blocked in Auth only when it has no other access", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const { user } = await employee(s, owner);
      await s.as(owner);
      expect((await s.query<{ r: boolean }>("select public.account_block_allowed($1, 'employee') r", [user])).rows[0].r).toBe(false);
      await s.asAdmin();
      await s.query("update public.company_memberships set active = false where user_id = $1", [user]);
      await s.as(owner);
      expect((await s.query<{ r: boolean }>("select public.account_block_allowed($1, 'employee') r", [user])).rows[0].r).toBe(true);
      expect((await s.query<{ r: boolean }>("select public.account_block_allowed($1, 'employee') r", [owner])).rows[0].r).toBe(false);
      await s.query("select public.account_access_record($1, 'employee', 'deactivated')", [user]);
      expect((await pgError(s.query("select public.account_access_record($1, 'employee', 'promoted')", [user]))).code).toBe("22023");
    });
  });

  it("portal: one customer, no duplicate contact, setup gate on the portal, never a membership; refused while closed", async () => {
    await withSession(async (s) => {
      const ids = await sampleIds(s);
      const owner = await s.createUser("owner");
      const username = uname("cust");
      const { user, key } = await provision(s, owner, "portal", username);
      await s.as(owner);
      expect((await pgError(s.query("select public.portal_create_login($1, $2, null, 'Pat Customer', '')", [key, ids.customerId]))).code).toBe("P0001");
      await openPortal(s, TOP_LINE);
      await s.as(owner);
      const contactName = `Pat Customer ${randomUUID().slice(0, 4)}`;
      const account = (await s.query<{ id: string }>("select public.portal_create_login($1, $2, null, $3, '') id", [key, ids.customerId, contactName])).rows[0].id;
      expect((await s.query<{ id: string }>("select public.portal_create_login($1, $2, null, $3, '') id", [key, ids.customerId, contactName])).rows[0].id).toBe(account); // retry
      await s.query("select public.account_setup_issue($1, 'portal', 168, 'print')", [user]);
      await s.asAdmin();
      expect((await s.query<{ n: number }>("select count(*)::int n from public.customer_contacts where company_id = $1 and name = $2", [TOP_LINE, contactName])).rows[0].n).toBe(1);
      expect((await s.query<{ n: number }>("select count(*)::int n from public.company_memberships where user_id = $1", [user])).rows[0].n).toBe(0);
      // A second login for the same (name-matched) contact is refused.
      const second = uname("cust");
      const p2 = await provision(s, owner, "portal", second);
      await s.as(owner);
      expect((await pgError(s.query("select public.portal_create_login($1, $2, null, $3, '')", [p2.key, ids.customerId, contactName.toUpperCase()]))).code).toBe("23505");
      // Before setup the portal gives nothing; after, it does.
      const slug = (await s.query<{ slug: string }>("select slug from public.companies where id = $1", [TOP_LINE])).rows[0].slug;
      await s.as(user);
      expect((await pgError(s.query("select public.portal_context($1)", [slug]))).code).not.toBe("");
      await s.asAdmin();
      await s.query("update auth.users set encrypted_password = 'own-hash' where id = $1", [user]);
      await s.as(user);
      await s.query("select public.account_setup_complete()");
      expect((await s.query<{ r: unknown }>("select public.portal_context($1) r", [slug])).rows[0].r).toBeTruthy();
      expect(await companyOf(s, user)).toBeNull();
      // Portal sign-ins are not employee sign-ins, and other companies cannot reach them.
      await s.as(owner);
      expect((await pgError(s.query("select public.account_setup_check($1, 'employee')", [user]))).code).toBe("P0002");
      const other = await s.createCompany(`Other ${randomUUID().slice(0, 6)}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.account_setup_check($1, 'portal')", [user]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.portal_reactivate($1)", [account]))).code).toBe("P0002");
      // Revoked: may be blocked; reactivated by the company only.
      await s.as(owner);
      await s.query("select public.portal_revoke($1)", [account]);
      expect((await s.query<{ r: boolean }>("select public.account_block_allowed($1, 'portal') r", [user])).rows[0].r).toBe(true);
      expect((await s.query<{ r: string }>("select public.portal_reactivate($1) r", [account])).rows[0].r).toBe(user);
    });
  });
});
