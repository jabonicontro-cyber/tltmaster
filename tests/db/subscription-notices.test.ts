// Subscription notices (SUB1, migration 20261120008800): renewal reminders 30/7/1 days before an annual renewal (unless
// renewal is off), a 30-day grace period when a live company goes over its plan, a proposed tier change after it, which
// takes effect only once a platform admin schedules it (date and agreed price), on that date. Every event is recorded
// once; customer notices wait for the app to email them; only platform admins and the service role reach any of it.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

async function platformAdmin(s: Session) {
  const id = await s.createUser(null, { membership: false });
  await s.asAdmin();
  const email = (await s.query<{ email: string }>("select email from auth.users where id = $1", [id])).rows[0].email;
  await s.query("set local role service_role");
  await s.query("select public.platform_admin_grant($1, 'test')", [email]);
  await s.asAdmin();
  return id;
}
type Plan = { id: string; plan_key: string; current: boolean; trucks: number | null; bases: number | null; monthly_cents: number | null };
type Event = { kind: string; detail: Record<string, unknown>; notice_status: string };
type State = { trucks: number; limit_trucks: number | null; renews_on: string | null; renewal_off: boolean; grace: { started_on: string; ends_on: string } | null;
  tier_change: { id: string; status: string; to_plan_version_id: string | null; effective_on: string | null } | null; events: Event[] };

describe("subscription notices", () => {
  it("renewal reminders once, over-limit grace, a proposed tier change applied only after a person schedules it", async () => {
    await withSession(async (s) => {
      const admin = await platformAdmin(s);
      await s.as(admin);
      const plans = (await s.query<{ r: Plan[] }>("select public.platform_plans() as r")).rows[0].r.filter((p) => p.current && p.plan_key !== "custom" && p.trucks);
      const smallest = plans.sort((a, b) => (a.trucks ?? 0) - (b.trucks ?? 0))[0];
      const c = (await s.query<{ id: string }>("select public.platform_create_company($1, 'America/Chicago', null) as id", [`Notice Hauling ${randomUUID().slice(0, 8)} (test)`])).rows[0].id;
      await s.query("select public.platform_lifecycle_terms($1, $2::jsonb)", [c, JSON.stringify({ plan_version_id: smallest.id, terms: "annual" })]);
      await s.asAdmin();
      // Live on an annual term that renews in 20 days (the 30-day reminder is due).
      await s.query("update private.company_lifecycle set stage = 'live', live_at = now(), terms = 'annual', commitment_start = private.company_today($1) - interval '1 year' + interval '20 days', agreed_monthly_cents = 1000 where company_id = $1", [c]);

      // Only platform admins.
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.platform_subscription_run()"))).code).toBe("42501");
      expect((await pgError(s.query("select public.platform_subscription_state($1)", [c]))).code).toBe("42501");

      await s.as(admin);
      await s.query("select public.platform_subscription_run()");
      await s.query("select public.platform_subscription_run()"); // a second run adds nothing
      let st = (await s.query<{ r: State }>("select public.platform_subscription_state($1) r", [c])).rows[0].r;
      const reminders = st.events.filter((e) => e.kind === "renewal_reminder");
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({ notice_status: "pending", detail: expect.objectContaining({ days_before: 30 }) });

      // Renewal turned off: no further reminders.
      await s.query("select public.platform_set_renewal($1, false)", [c]);
      await s.asAdmin();
      await s.query("update private.company_lifecycle set commitment_start = commitment_start - interval '15 days' where company_id = $1", [c]); // now 5 days out
      await s.as(admin);
      await s.query("select public.platform_subscription_run()");
      st = (await s.query<{ r: State }>("select public.platform_subscription_state($1) r", [c])).rows[0].r;
      expect(st.renewal_off).toBe(true);
      expect(st.events.filter((e) => e.kind === "renewal_reminder")).toHaveLength(1);

      // Over the truck limit: grace starts with a notice. Hired trucks never count.
      await s.asAdmin();
      for (let i = 0; i <= (smallest.trucks ?? 0); i++) {
        await s.query("insert into public.trucks (company_id, unit_number, truck_type) values ($1, $2, 'tri_axle_dump')", [c, `N${i}-${randomUUID().slice(0, 4)}`]);
      }
      await s.as(admin);
      await s.query("select public.platform_subscription_run()");
      st = (await s.query<{ r: State }>("select public.platform_subscription_state($1) r", [c])).rows[0].r;
      expect(st.trucks).toBe((smallest.trucks ?? 0) + 1);
      expect(st.grace).not.toBeNull();
      expect(st.events.find((e) => e.kind === "over_limit")?.notice_status).toBe("pending");

      // 30 days later and still over: a tier change is proposed to the platform team (no customer notice yet).
      await s.asAdmin();
      await s.query("update private.subscription_grace set started_on = started_on - 31, ends_on = ends_on - 31 where company_id = $1", [c]);
      await s.as(admin);
      await s.query("select public.platform_subscription_run()");
      st = (await s.query<{ r: State }>("select public.platform_subscription_state($1) r", [c])).rows[0].r;
      expect(st.tier_change).toMatchObject({ status: "due" });
      expect(st.tier_change!.to_plan_version_id).not.toBe(smallest.id);
      expect(st.events.find((e) => e.kind === "tier_change_due")?.notice_status).toBe("not_needed");
      // Nothing changed yet.
      await s.asAdmin();
      expect((await s.query<{ p: string }>("select plan_version_id p from private.company_lifecycle where company_id = $1", [c])).rows[0].p).toBe(smallest.id);

      // A person schedules it (later date, agreed price); the customer is notified; it applies on that date.
      await s.asAdmin();
      const today = (await s.query<{ d: string }>("select private.company_today($1)::text d", [c])).rows[0].d;
      await s.as(admin);
      expect((await pgError(s.query("select public.platform_tier_change_schedule($1, null, $2::date, 2000)", [st.tier_change!.id, today]))).message).toMatch(/later date/);
      await s.query("select public.platform_tier_change_schedule($1, null, $2::date + 3, 2000)", [st.tier_change!.id, today]);
      st = (await s.query<{ r: State }>("select public.platform_subscription_state($1) r", [c])).rows[0].r;
      expect(st.events.find((e) => e.kind === "tier_change_scheduled")?.notice_status).toBe("pending");
      await s.asAdmin();
      await s.query("update private.tier_changes set effective_on = private.company_today($1) where company_id = $1 and status = 'scheduled'", [c]);
      await s.as(admin);
      await s.query("select public.platform_subscription_run()");
      await s.asAdmin();
      const life = (await s.query<{ p: string; m: number }>("select plan_version_id p, agreed_monthly_cents m from private.company_lifecycle where company_id = $1", [c])).rows[0];
      expect(life).toEqual({ p: st.tier_change!.to_plan_version_id, m: 2000 });
      await s.as(admin);
      st = (await s.query<{ r: State }>("select public.platform_subscription_state($1) r", [c])).rows[0].r;
      expect(st.tier_change).toBeNull();
      expect(st.events.some((e) => e.kind === "tier_change_applied")).toBe(true);

      // The app reads pending notices (service role only) with the owners' addresses, and marks each one.
      await s.as(admin);
      expect((await pgError(s.query("select public.subscription_pending_notices()"))).code).toBe("42501");
      await s.asAdmin();
      await s.query("set local role service_role");
      const pending = (await s.query<{ r: Array<{ id: string; kind: string; to: string[] }> }>("select public.subscription_pending_notices() r")).rows[0].r;
      const mine = pending.filter((p) => ["renewal_reminder", "over_limit", "tier_change_scheduled", "tier_change_applied"].includes(p.kind));
      expect(mine.length).toBeGreaterThan(0);
      await s.query("select public.subscription_notice_mark($1, 'previewed', 'Email not configured')", [mine[0].id]);
      await s.asAdmin();
      expect((await s.query<{ n: string }>("select notice_status n from private.subscription_events where id = $1", [mine[0].id])).rows[0].n).toBe("previewed");
    });
  });
});
