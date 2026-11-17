// Platform console PC2 (migrations 20261120022300 and 20261120022400): an Admin invites a company's first owner with a
// single-use, expiring link the owner accepts themselves (password, authenticator, accept), audited in the platform
// audit and the company's history; and the month-by-month view of AGREED monthly revenue, Admin only. Both rollbacks.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const MIGRATIONS = ["20261120022300_platform_owner_invite", "20261120022400_platform_revenue_by_month"];
const rollback = (n: string) => readFileSync(join(__dirname, `../../supabase/rollbacks/${n}.down.sql`), "utf8").replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");
const one = async <T>(s: Session, sql: string, params: unknown[] = []) => (await s.query<{ r: T }>(sql, params)).rows[0].r;

async function staff(s: Session, level: "admin" | "support" = "admin") {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  await s.query("update private.platform_admins set level = $2 where user_id = $1", [id, level]);
  return id;
}

/** The Admin just entered their password and authenticator code again (as the console's re-authentication does). */
async function freshReauth(s: Session, user: string) {
  await s.asAdmin();
  const factor = randomUUID();
  await s.query("update auth.users set last_sign_in_at = now() where id = $1", [user]);
  await s.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, $3, 'totp', 'verified', now(), now())", [factor, user, `app ${factor.slice(0, 6)}`]);
  await s.query("insert into auth.mfa_challenges (id, factor_id, created_at, verified_at, ip_address) values (gen_random_uuid(), $1, now(), now(), '127.0.0.1')", [factor]);
}

/** A sign-in for the invited email (address confirmed unless said otherwise), optionally with a verified authenticator app. */
async function signInFor(s: Session, email: string, withApp: boolean, confirmed = true) {
  await s.asAdmin();
  const id = randomUUID();
  await s.query("insert into auth.users (id, email, aud, role, email_confirmed_at) values ($1, $2, 'authenticated', 'authenticated', case when $3 then now() end)", [id, email, confirmed]);
  if (withApp) await s.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'app', 'totp', 'verified', now(), now())", [id]);
  return id;
}

async function addApp(s: Session, user: string) {
  await s.asAdmin();
  await s.query("insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'app', 'totp', 'verified', now(), now())", [user]);
}

const invite = (s: Session, company: string, email: string, name = "Riley Owner") =>
  one<{ id: string; token: string; email: string; expires_at: string; company_name: string }>(s, "select public.platform_owner_invite($1, $2, $3) r", [company, email, name]);
const peek = (s: Session, token: string) => one<{ status: string; email?: string; company_name?: string; has_account?: boolean; link_emailed?: boolean }>(s, "select public.owner_invite_peek($1) r", [token]);

describe("owner invitations from the console", () => {
  it("only an Admin with a fresh password and code invites; the owner accepts once, as that email, with an authenticator app", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const sup = await staff(s, "support");
      const c = await s.createCompany(`Owner Invite Haul ${randomUUID().slice(0, 6)} (test)`);
      const other = await s.createCompany(`Other Haul ${randomUUID().slice(0, 6)} (test)`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      const email = `first-owner-${randomUUID().slice(0, 8)}@test.example`;
      await s.asAdmin();
      await s.query("insert into public.employees (company_id, full_name, work_email, department) values ($1, 'Riley Owner', $2, 'management')", [c, email]);

      // Support and company people are refused; an Admin needs a fresh password and code.
      for (const who of [sup, otherOwner]) {
        await s.as(who);
        expect((await pgError(s.query("select public.platform_owner_invite($1, $2, 'Riley Owner')", [c, email]))).code).toBe("42501");
        expect((await pgError(s.query("select public.platform_owner_invites($1)", [c]))).code).toBe("42501");
      }
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_owner_invite($1, $2, 'Riley Owner')", [c, email]))).message).toMatch(/password and authenticator code again/);
      await freshReauth(s, adm);
      await s.as(adm);

      // Refused: a company that already has an owner, a demo, an email of the Taviron team, a bad email.
      expect((await pgError(s.query("select public.platform_owner_invite($1, $2, 'Riley Owner')", [other, email]))).message).toMatch(/already has an owner/);
      await s.asAdmin();
      const supEmail = (await s.query<{ email: string }>("select email from auth.users where id = $1", [sup])).rows[0].email;
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_owner_invite($1, $2, 'Sam Staff')", [c, supEmail]))).message).toMatch(/belongs to the Taviron team/);
      expect((await pgError(s.query("select public.platform_owner_invite($1, 'nope', 'Riley Owner')", [c]))).code).toBe("22023");
      expect((await pgError(s.query("select public.platform_owner_invite(gen_random_uuid(), $1, 'Riley Owner')", [email]))).code).toBe("P0002");
      await s.asAdmin();
      const demo = await s.createCompany(`Demo Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_owner_invite($1, $2, 'Riley Owner')", [demo, email]))).message).toMatch(/Demo companies/);

      // The first invitation is replaced by a second one; only the hash of each token is stored.
      const first = await invite(s, c, email);
      const inv = await invite(s, c, email.toUpperCase());
      expect(inv.token).toMatch(/^[0-9a-f]{64}$/);
      expect(inv.email).toBe(email);
      await s.asAdmin();
      expect((await s.query("select 1 from private.owner_invitations where token_hash in ($1, $2)", [first.token, inv.token])).rowCount).toBe(0);
      expect(Date.parse((await s.query<{ e: string }>("select expires_at e from private.owner_invitations where id = $1", [inv.id])).rows[0].e) - Date.now()).toBeLessThanOrEqual(72 * 3_600_000 + 60_000);

      // The link holder (signed out) sees who it is for; the replaced and made-up links show nothing to accept.
      await s.as(null);
      expect(await peek(s, inv.token)).toMatchObject({ status: "open", email, has_account: false, company_name: expect.stringContaining("Owner Invite Haul") });
      expect((await peek(s, first.token)).status).toBe("withdrawn");
      expect(await peek(s, "0".repeat(64))).toEqual({ status: "invalid" });
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv.token]))).code).toBe("42501");

      await s.as(adm);
      const listed = await one<{ blocked: string | null; invites: Array<{ id: string; status: string }> }>(s, "select public.platform_owner_invites($1) r", [c]);
      expect(listed.blocked).toBeNull();
      expect(listed.invites.map((i) => [i.id, i.status])).toEqual([[inv.id, "open"], [first.id, "withdrawn"]]);

      // Someone else cannot accept it; the invitee needs an authenticator app and a verified (aal2) session.
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv.token]))).message).toMatch(/This invitation is for/);
      const invitee = await signInFor(s, email, false);
      await s.as(invitee);
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv.token]))).message).toMatch(/authenticator app/);
      await addApp(s, invitee);
      await s.query("reset role");
      await s.query("set local role authenticated");
      await s.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: invitee, role: "authenticated", aal: "aal1" })]);
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv.token]))).message).toMatch(/authenticator app/);

      await s.as(invitee);
      expect(await one<string>(s, "select public.owner_invite_accept($1) r", [inv.token])).toBe(c);
      await s.asAdmin();
      expect((await s.query("select role, active from public.company_memberships where company_id = $1 and user_id = $2", [c, invitee])).rows).toEqual([{ role: "owner", active: true }]);
      expect((await s.query<{ a: string }>("select active_company_id a from public.profiles where id = $1", [invitee])).rows[0].a).toBe(c);
      expect((await s.query<{ n: number }>("select count(*)::int n from public.employees where company_id = $1 and user_id = $2", [c, invitee])).rows[0].n).toBe(1);
      expect((await s.query<{ n: number }>("select count(*)::int n from public.employees where company_id = $1 and lower(work_email) = $2", [c, email])).rows[0].n).toBe(1);

      // Single use: a second accept is refused and the link reads "used"; the company cannot get another first owner.
      await s.as(invitee);
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv.token]))).code).toBe("P0002");
      await s.as(null);
      expect((await peek(s, inv.token)).status).toBe("used");
      await freshReauth(s, adm);
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_owner_invite($1, 'someone@test.example', 'Someone Else')", [c]))).message).toMatch(/already has an owner/);
      expect((await one<{ blocked: string }>(s, "select public.platform_owner_invites($1) r", [c])).blocked).toMatch(/already has an owner/);

      // Audited in the platform audit and in the company's own history.
      await s.asAdmin();
      const platform = (await s.query<{ action: string; actor_id: string }>("select action, actor_id from private.platform_audit where target_type = 'company' and target_id = $1 order by occurred_at, action", [c])).rows;
      expect(platform.filter((a) => a.action === "owner_invited")).toHaveLength(2);
      expect(platform).toEqual(expect.arrayContaining([{ action: "owner_invited", actor_id: adm }, { action: "owner_joined", actor_id: invitee }]));
      const history = (await s.query<{ action: string; summary: string }>("select action, summary from public.audit_events where company_id = $1 and action like 'member.%' order by occurred_at", [c])).rows;
      expect(history).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "member.invited", summary: expect.stringMatching(/^The Taviron team invited Riley Owner/) }),
        expect.objectContaining({ action: "member.joined", summary: "Accepted the invitation as owner" }),
      ]));
    });
  });

  it("an invitation expires, can be withdrawn, and cannot be used once the company has an owner or by the Taviron team", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const sup = await staff(s, "support");
      const c = await s.createCompany(`Expiring Haul ${randomUUID().slice(0, 6)} (test)`);
      await freshReauth(s, adm);
      await s.as(adm);

      // Expired.
      const email = `late-${randomUUID().slice(0, 8)}@test.example`;
      const inv = await invite(s, c, email);
      await s.asAdmin();
      await s.query("update private.owner_invitations set expires_at = now() - interval '1 minute' where id = $1", [inv.id]);
      const late = await signInFor(s, email, true);
      await s.as(late);
      expect((await peek(s, inv.token)).status).toBe("expired");
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv.token]))).code).toBe("P0002");

      // Withdrawn: Support cannot; the Admin can, audited in both places.
      await s.as(adm);
      const inv2 = await invite(s, c, `withdrawn-${randomUUID().slice(0, 8)}@test.example`);
      await s.as(sup);
      expect((await pgError(s.query("select public.platform_owner_invite_withdraw($1)", [inv2.id]))).code).toBe("42501");
      await s.as(adm);
      await s.query("select public.platform_owner_invite_withdraw($1)", [inv2.id]);
      expect((await pgError(s.query("select public.platform_owner_invite_withdraw($1)", [inv2.id]))).code).toBe("P0002");
      expect((await peek(s, inv2.token)).status).toBe("withdrawn");
      await s.asAdmin();
      expect((await s.query("select 1 from private.platform_audit where action = 'owner_invite_withdrawn' and target_id = $1", [c])).rowCount).toBe(1);
      expect((await s.query("select 1 from public.audit_events where company_id = $1 and action = 'member.invite_withdrawn'", [c])).rowCount).toBe(1);

      // Someone became the owner another way after the invitation: it can no longer be used.
      await s.as(adm);
      const email3 = `slow-${randomUUID().slice(0, 8)}@test.example`;
      const inv3 = await invite(s, c, email3);
      const slow = await signInFor(s, email3, true);
      await s.createUser("owner", { companyId: c });
      await s.as(slow);
      expect((await peek(s, inv3.token)).status).toBe("closed");
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv3.token]))).message).toMatch(/already has an owner/);

      // A person who joined the Taviron team after being invited cannot accept.
      const c4 = await s.createCompany(`Turned Staff Haul ${randomUUID().slice(0, 6)} (test)`);
      await freshReauth(s, adm);
      await s.as(adm);
      const email4 = `turned-staff-${randomUUID().slice(0, 8)}@test.example`;
      const inv4 = await invite(s, c4, email4);
      const turned = await signInFor(s, email4, true);
      await s.asAdmin();
      await s.query("insert into private.platform_admins (user_id, note, level) values ($1, 'test', 'support')", [turned]);
      await s.as(turned);
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv4.token]))).message).toMatch(/Taviron team sign-in cannot be a customer's owner/);
    });
  });
});

// Security review 2026-11-16: a link that was handed over proves nothing about the mailbox; only a first owner, never a
// replacement for an owner the company had; never re-activating a membership the person had.
describe("owner invitations: confirmed email, first owner only", () => {
  it("accepting needs a confirmed email; only the service role records the link as emailed; has_account means confirmed", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const c = await s.createCompany(`Handed Over Haul ${randomUUID().slice(0, 6)} (test)`);
      await freshReauth(s, adm);
      await s.as(adm);
      const email = `handed-${randomUUID().slice(0, 8)}@test.example`;
      const inv = await invite(s, c, email);
      expect(Date.parse(inv.expires_at) - Date.now()).toBeGreaterThan(71 * 3_600_000);
      expect(Date.parse(inv.expires_at) - Date.now()).toBeLessThanOrEqual(72 * 3_600_000 + 60_000);

      // Not emailed: the page will ask for an email code.
      await s.as(null);
      expect(await peek(s, inv.token)).toMatchObject({ status: "open", link_emailed: false, has_account: false });
      // Only the server (service role) records the email, once.
      for (const who of [adm, null]) {
        await s.as(who);
        expect((await pgError(s.query("select public.owner_invite_mark_emailed($1)", [inv.id]))).code).toBe("42501");
      }

      // A sign-in whose address is not confirmed (the code was never entered) cannot accept, even with an authenticator.
      const invitee = await signInFor(s, email, true, false);
      await s.as(null);
      expect((await peek(s, inv.token)).has_account).toBe(false);
      await s.as(invitee);
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [inv.token]))).message).toMatch(/Confirm your email address first/);
      await s.asAdmin();
      expect((await s.query("select 1 from public.company_memberships where company_id = $1", [c])).rowCount).toBe(0);
      await s.query("update auth.users set email_confirmed_at = now() where id = $1", [invitee]);
      await s.as(null);
      expect((await peek(s, inv.token)).has_account).toBe(true);
      await s.as(invitee);
      expect(await one<string>(s, "select public.owner_invite_accept($1) r", [inv.token])).toBe(c);

      // Marking: service role, a new open invitation, once.
      const c2 = await s.createCompany(`Mailed Haul ${randomUUID().slice(0, 6)} (test)`);
      await freshReauth(s, adm);
      await s.as(adm);
      const mailed = await invite(s, c2, `mailed-${randomUUID().slice(0, 8)}@test.example`);
      await s.asAdmin();
      await s.query("set local role service_role");
      expect(await one<boolean>(s, "select public.owner_invite_mark_emailed($1) r", [mailed.id])).toBe(true);
      expect(await one<boolean>(s, "select public.owner_invite_mark_emailed($1) r", [mailed.id])).toBe(false);
      expect(await one<boolean>(s, "select public.owner_invite_mark_emailed($1) r", [inv.id])).toBe(false); // already accepted
      await s.as(null);
      expect((await peek(s, mailed.token)).link_emailed).toBe(true);
    });
  });

  it("never for a company that had an owner, that is live, or to re-activate a membership the person had", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      await freshReauth(s, adm);

      // Had an owner (deactivated): refused, and an open invitation stops working.
      const had = await s.createCompany(`Had Owner Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.as(adm);
      const email = `late-${randomUUID().slice(0, 8)}@test.example`;
      const open = await invite(s, had, email);
      const former = await s.createUser("owner", { companyId: had });
      await s.asAdmin();
      await s.query("update public.company_memberships set active = false where user_id = $1 and company_id = $2", [former, had]);
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_owner_invite($1, $2, 'Riley Owner')", [had, email]))).message).toMatch(/had an owner before/);
      expect((await one<{ blocked: string }>(s, "select public.platform_owner_invites($1) r", [had])).blocked).toMatch(/had an owner before/);
      const late = await signInFor(s, email, true);
      await s.as(late);
      expect((await peek(s, open.token)).status).toBe("closed");
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [open.token]))).message).toMatch(/had an owner before/);
      await s.asAdmin();
      expect((await s.query("select active from public.company_memberships where user_id = $1 and company_id = $2", [former, had])).rows).toEqual([{ active: false }]);

      // Had an owner by an accepted invitation, who is no longer an owner there: still refused.
      const viaInvite = await s.createCompany(`Invited Before Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.as(adm);
      const first = await invite(s, viaInvite, `first-${randomUUID().slice(0, 8)}@test.example`);
      const firstOwner = await signInFor(s, first.email, true);
      await s.as(firstOwner);
      await s.query("select public.owner_invite_accept($1)", [first.token]);
      await s.asAdmin();
      await s.query("update public.company_memberships set role = 'dispatcher', active = false where user_id = $1 and company_id = $2", [firstOwner, viaInvite]);
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_owner_invite($1, 'second@test.example', 'Second Owner')", [viaInvite]))).message).toMatch(/had an owner before/);

      // Live: refused.
      const live = await s.createCompany(`Live Haul ${randomUUID().slice(0, 6)} (test)`);
      await s.asAdmin();
      await s.query("insert into private.company_lifecycle (company_id, stage, live_at) values ($1, 'live', now())", [live]);
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_owner_invite($1, 'live@test.example', 'Live Owner')", [live]))).message).toMatch(/already live/);

      // A person with an ended (non-owner) membership is not re-activated: refused, nothing changed.
      const ended = await s.createCompany(`Ended Member Haul ${randomUUID().slice(0, 6)} (test)`);
      const emailE = `ended-${randomUUID().slice(0, 8)}@test.example`;
      const person = await signInFor(s, emailE, true);
      await s.asAdmin();
      await s.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, 'dispatcher', false)", [ended, person]);
      await s.as(adm);
      const invE = await invite(s, ended, emailE);
      await s.as(person);
      expect((await pgError(s.query("select public.owner_invite_accept($1)", [invE.token]))).message).toMatch(/already have, or had, a sign-in for this company/);
      await s.asAdmin();
      expect((await s.query("select role, active from public.company_memberships where user_id = $1 and company_id = $2", [person, ended])).rows).toEqual([{ role: "dispatcher", active: false }]);
      expect((await s.query<{ a: string | null }>("select accepted_at a from private.owner_invitations where id = $1", [invE.id])).rows[0].a).toBeNull();
    });
  });
});

interface Month { month: string; customers: number; paying: number; free: number; not_recorded: number; agreed_cents: number; change_cents: number | null; new: Array<{ id: string; name: string; cents: number | null }>; lost: Array<{ id: string; name: string; cents: number | null; canceled: boolean }> }
interface Report { months: Month[]; renewals: Array<{ company_id: string; days: number; renewal_off: boolean; agreed_monthly_cents: number }>; scheduled_changes: Array<{ company_id: string }> }

describe("revenue over time (agreed, not collected)", () => {
  it("is Admin only", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      const sup = await staff(s, "support");
      const owner = await s.createUser("owner");
      for (const who of [sup, owner]) {
        await s.as(who);
        expect((await pgError(s.query("select public.platform_revenue_by_month(12)"))).code).toBe("42501");
      }
      await s.as(null);
      expect((await pgError(s.query("select public.platform_revenue_by_month(12)"))).code).toBe("42501");
      await s.as(adm);
      expect((await pgError(s.query("select public.platform_revenue_by_month(0)"))).code).toBe("22023");
      expect((await pgError(s.query("select public.platform_revenue_by_month(37)"))).code).toBe("22023");
      expect((await one<Report>(s, "select public.platform_revenue_by_month(12) r")).months).toHaveLength(12);
    });
  });

  it("matches the recorded agreements: a mid-month change, a cancellation, a plan change, a missing amount; demos never count", async () => {
    await withSession(async (s) => {
      const adm = await staff(s, "admin");
      await s.as(adm);
      const before = await one<Report>(s, "select public.platform_revenue_by_month(6) r");
      await s.asAdmin();
      // Day `d` (1-based) of the month `back` months before this one, at noon UTC.
      const at = (back: number, d: number) => `date_trunc('month', now() at time zone 'UTC') - interval '${back} months' + interval '${d - 1} days 12 hours'`;
      const mk = async (label: string) => {
        const id = await s.createCompany(`Revenue ${label} ${randomUUID().slice(0, 6)} (test)`);
        await s.query("update public.company_settings set timezone = 'UTC' where company_id = $1", [id]);
        return id;
      };
      const terms = (company: string, when: string, cents: number, prev: number | null) =>
        s.query(`insert into private.platform_audit (actor_id, action, target_type, target_id, summary, detail, occurred_at)
                 values ($1, 'lifecycle_terms_set', 'company', $2, 'test', jsonb_build_object('company_id', $2::text, 'agreed_monthly_cents', $3::int, 'previous_agreed_monthly_cents', $4::int), ${when})`,
          [adm, company, cents, prev]);
      const live = (company: string, when: string, cents: number, extra = "") =>
        s.query(`insert into private.company_lifecycle (company_id, stage, live_at, agreed_monthly_cents${extra ? ", terms, commitment_start" : ""}) values ($1, 'live', ${when}, $2${extra})`, [company, cents]);

      // A: live on day 5 four months ago at $499; changed to $749 on the 15th two months ago (mid-month).
      const A = await mk("A");
      await terms(A, at(4, 3), 49900, null);
      await live(A, at(4, 5), 74900);
      await terms(A, at(2, 15), 74900, 49900);
      // B: live three months ago at $999, canceled on day 5 last month.
      const B = await mk("B");
      await terms(B, at(3, 2), 99900, null);
      await live(B, at(3, 10), 99900);
      await s.query(`update private.company_lifecycle set stage = 'canceled', canceled_at = ${at(1, 5)} where company_id = $1`, [B]);
      // C: $299 from three months ago; a scheduled plan change to $399 took effect on the 20th last month.
      const C = await mk("C");
      await terms(C, at(3, 1), 29900, null);
      await live(C, at(3, 3), 39900);
      await s.query(`insert into private.subscription_events (company_id, kind, period_key, detail, notice_status)
                     values ($1, 'tier_change_applied', 'test', jsonb_build_object('effective_on', (${at(1, 20)})::date, 'agreed_monthly_cents', 39900), 'not_needed')`, [C]);
      // F: annual, live for eleven months at $599: renews in 20 days.
      const F = await mk("F");
      const fStart = "((now() at time zone 'UTC')::date + 20 - interval '1 year')";
      await terms(F, `${fStart} - interval '1 day'`, 59900, null);
      await live(F, `${fStart} + interval '12 hours'`, 59900, `, 'annual', ${fStart}::date`);
      // G: live two months ago with no recorded amount until a plan change last month: "not recorded", never guessed.
      const G = await mk("G");
      await live(G, at(2, 2), 10000);
      await s.query(`insert into private.subscription_events (company_id, kind, period_key, detail, notice_status)
                     values ($1, 'tier_change_applied', 'test', jsonb_build_object('effective_on', (${at(1, 11)})::date, 'agreed_monthly_cents', 10000), 'not_needed')`, [G]);
      // A demo company with a live record and an agreement never counts.
      const D = await mk("Demo");
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [D]);
      await terms(D, at(3, 1), 77700, null);
      await live(D, at(3, 2), 77700);

      await s.as(adm);
      const after = await one<Report>(s, "select public.platform_revenue_by_month(6) r");
      expect(after.months.map((m) => m.month)).toEqual(before.months.map((m) => m.month));
      const diff = (k: keyof Month) => after.months.map((m, i) => (m[k] as number) - (before.months[i][k] as number));
      // Oldest first: five months ago … this month.
      expect(diff("agreed_cents")).toEqual([
        59900,
        59900 + 49900,
        59900 + 49900 + 99900 + 29900,
        59900 + 74900 + 99900 + 29900,
        59900 + 74900 + 39900 + 10000,
        59900 + 74900 + 39900 + 10000,
      ]);
      expect(diff("customers")).toEqual([1, 2, 4, 5, 4, 4]);
      expect(diff("not_recorded")).toEqual([0, 0, 0, 1, 0, 0]);
      const agreed = diff("agreed_cents");
      expect(diff("change_cents").slice(1)).toEqual(agreed.slice(1).map((v, i) => v - agreed[i]));
      const names = (list: Array<{ id: string }>) => list.map((x) => x.id);
      expect(names(after.months[1].new)).toContain(A);
      expect(names(after.months[2].new)).toEqual(expect.arrayContaining([B, C]));
      expect(after.months[4].lost.find((x) => x.id === B)).toMatchObject({ cents: 99900, canceled: true });
      expect(after.months[1].new.find((x) => x.id === A)).toMatchObject({ cents: 49900 });
      for (const m of after.months) expect([...names(m.new), ...names(m.lost)]).not.toContain(D);
      expect(after.renewals.find((r) => r.company_id === F)).toMatchObject({ days: 20, renewal_off: false, agreed_monthly_cents: 59900 });
      expect(after.renewals.map((r) => r.company_id)).not.toContain(A);
    });
  });
});

describe("rollbacks", () => {
  it("remove the owner invitations and the revenue view; earlier console functions keep working", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      for (const n of [...MIGRATIONS].reverse()) await s.query(rollback(n)).catch((e: Error) => { throw new Error(`${n}: ${e.message}`); });
      const left = (await s.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.proname in ('platform_owner_invite', 'platform_owner_invite_withdraw', 'platform_owner_invites',
          'owner_invite_peek', 'owner_invite_accept', 'owner_invite_blocked', 'company_has_owner', 'company_had_owner', 'owner_invite_mark_emailed',
          'platform_revenue_by_month', 'agreed_monthly_on')`)).rows;
      expect(left).toEqual([]);
      expect((await s.query("select to_regclass('private.owner_invitations') r")).rows[0].r).toBeNull();
      const adm = await staff(s, "admin");
      await s.as(adm);
      expect((await one<{ mrr: unknown }>(s, "select public.platform_console() r")).mrr).toBeTruthy();
    });
  });
});
