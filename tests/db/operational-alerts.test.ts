import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// Operational alerts: priorities with safety minimums, acknowledgment, escalation,
// reassignment, resolution, deduplication and tenancy. Each test runs in its own
// throwaway company so seeded users never become recipients.

async function company(s: Session) {
  const c = await s.createCompany(`Alerts ${Math.random().toString(36).slice(2, 6)}`);
  const u = {
    owner: await s.createUser("owner", { companyId: c }),
    dispatcher: await s.createUser("dispatcher", { companyId: c }),
    office: await s.createUser("office", { companyId: c }),
    mechanic: await s.createUser("mechanic", { companyId: c }),
    driver: await s.createUser("driver", { companyId: c }),
  };
  return { c, u };
}

const raise = async (s: Session, c: string, type: string, key: string, recipients: string[], priority: string | null = null) => {
  await s.asAdmin();
  return (await s.query<{ id: string }>("select private.comm_raise_alert($1, $2, $3, 'truck', null, $4, 'detail', '/x', $5::uuid[], $6) as id",
    [c, type, key, `Alert ${key}`, recipients, priority])).rows[0].id;
};
const alert = async (s: Session, id: string) => {
  await s.asAdmin();
  return (await s.query("select * from public.alerts where id = $1", [id])).rows[0];
};
const outstanding = async (s: Session, id: string) => {
  await s.asAdmin();
  return ((await s.query<{ o: string[] }>("select private.alert_outstanding($1) as o", [id])).rows[0].o ?? []).sort();
};
const events = async (s: Session, id: string) => {
  await s.asAdmin();
  return (await s.query<{ kind: string }>("select kind from public.alert_events where alert_id = $1 order by created_at, id", [id])).rows.map((r) => r.kind);
};
const ack = (s: Session, id: string) => s.query("select public.comm_alert_acknowledge($1, '')", [id]);
const housekeep = async (s: Session, c: string, as: string) => {
  await s.asAdmin();
  await s.query("delete from public.comm_housekeeping_runs where company_id = $1", [c]);
  await s.as(as);
  return (await s.query<{ r: { escalated: number } }>("select public.comm_housekeeping() as r")).rows[0].r;
};

describe("priorities and safety minimums", () => {
  it("a repeat of the same event updates the open alert; a distinct event gets its own", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      const a = await raise(s, c, "dispatch.breakdown_report", "r1", [u.dispatcher]);
      expect(await raise(s, c, "dispatch.breakdown_report", "r1", [u.dispatcher])).toBe(a);
      expect((await alert(s, a)).occurrences).toBe(2);
      expect(await events(s, a)).toEqual(["created", "occurred_again"]);
      const b = await raise(s, c, "dispatch.breakdown_report", "r2", [u.dispatcher]);
      expect(b).not.toBe(a);
      // A raise below the type's minimum is lifted to the minimum.
      const low = await raise(s, c, "maintenance.safety_restriction", "w1", [u.dispatcher], "informational");
      expect((await alert(s, low)).priority).toBe("critical");
    });
  });

  it("priority can be raised and lowered, never below the minimum; changes need a reason and are recorded", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      const a = await raise(s, c, "dispatch.breakdown_report", "r1", [u.dispatcher]);
      expect((await alert(s, a)).priority).toBe("critical");
      expect((await alert(s, a)).escalation_due_at).not.toBeNull();
      await s.as(u.dispatcher);
      expect((await pgError(s.query("select public.comm_alert_set_priority($1, 'informational', 'Not urgent')", [a]))).message).toMatch(/safety minimum/);
      expect((await pgError(s.query("select public.comm_alert_set_priority($1, 'action_required', '')", [a]))).message).toMatch(/reason/);
      await s.query("select public.comm_alert_set_priority($1, 'action_required', 'Truck is parked safely')", [a]);
      const row = await alert(s, a);
      expect([row.priority, row.escalation_due_at]).toEqual(["action_required", null]);
      expect(await events(s, a)).toEqual(["created", "priority_changed", "escalation_canceled"]);
      // Office and drivers cannot change priorities.
      await s.as(u.office);
      expect((await pgError(s.query("select public.comm_alert_set_priority($1, 'critical', 'Because')", [a]))).code).toBe("42501");

      // Raising an informational alert makes informed recipients responsible.
      const i = await raise(s, c, "dispatch.assignment_canceled", "x1", [u.driver]);
      await s.asAdmin();
      expect((await s.query("select reason, responsible from public.alert_recipients where alert_id = $1", [i])).rows[0]).toEqual({ reason: "informed", responsible: false });
      expect(await outstanding(s, i)).toEqual([]);
      await s.as(u.dispatcher);
      await s.query("select public.comm_alert_set_priority($1, 'action_required', 'Driver must confirm')", [i]);
      expect(await outstanding(s, i)).toEqual([u.driver]);
    });
  });

  it("company settings never go below the minimum and safety alerts cannot be turned off", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      await s.as(u.dispatcher);
      expect((await pgError(s.query("select public.comm_save_alert_setting('time_off.requested', '{\"enabled\": false}'::jsonb)"))).code).toBe("42501");
      await s.as(u.owner);
      expect((await pgError(s.query("select public.comm_save_alert_setting('maintenance.safety_restriction', '{\"enabled\": false}'::jsonb)"))).message).toMatch(/cannot be turned off/);
      expect((await pgError(s.query("select public.comm_save_alert_setting('documents.expired', '{\"default_priority\": \"informational\"}'::jsonb)"))).message).toMatch(/safety minimum/);
      await s.query("select public.comm_save_alert_setting('time_off.requested', '{\"enabled\": false}'::jsonb)");
      expect(await raise(s, c, "time_off.requested", "t1", [u.owner])).toBeNull();
      await s.as(u.owner);
      await s.query("select public.comm_save_alert_setting('documents.expiring', '{\"default_priority\": \"informational\"}'::jsonb)");
      expect((await alert(s, await raise(s, c, "documents.expiring", "d1", [u.owner]))).priority).toBe("informational");
      // Settings changes are audited.
      await s.asAdmin();
      expect((await s.query("select count(*)::int as n from public.audit_events where company_id = $1 and entity_type = 'comm_alert_settings'", [c])).rows[0].n).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("acknowledgment, escalation, reassignment and resolution", () => {
  it("'any' scope: one responsible recipient acknowledges for everyone; reading is not acknowledging", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      const a = await raise(s, c, "maintenance.safety_restriction", "w1", [u.dispatcher, u.owner]);
      await s.as(u.dispatcher);
      await s.query("select id from public.alerts where id = $1", [a]); // reading
      expect(await outstanding(s, a)).toEqual([u.dispatcher, u.owner].sort());
      await s.as(u.office); // not a recipient
      expect((await pgError(ack(s, a))).code).toBe("42501");
      await s.as(u.dispatcher);
      await ack(s, a);
      await ack(s, a); // idempotent
      expect(await outstanding(s, a)).toEqual([]);
      expect((await alert(s, a)).escalation_due_at).toBeNull();
      expect((await events(s, a)).filter((k) => k === "acknowledged")).toHaveLength(1);
      expect((await alert(s, a)).status).toBe("open"); // acknowledged is not resolved
    });
  });

  it("'all' scope: every designated recipient must acknowledge; reassignment moves responsibility explicitly", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      await s.as(u.owner);
      await s.query("select public.comm_save_alert_setting('maintenance.safety_restriction', '{\"ack_scope\": \"all\"}'::jsonb)");
      const a = await raise(s, c, "maintenance.safety_restriction", "w1", [u.dispatcher, u.mechanic]);
      await s.as(u.dispatcher);
      await ack(s, a);
      expect(await outstanding(s, a)).toEqual([u.mechanic]);
      await s.as(u.dispatcher);
      expect((await pgError(s.query("select public.comm_alert_reassign($1, $2, $3, '')", [a, u.mechanic, u.office]))).message).toMatch(/reason/);
      await s.query("select public.comm_alert_reassign($1, $2, $3, 'Mechanic is off today')", [a, u.mechanic, u.office]);
      expect(await outstanding(s, a)).toEqual([u.office]);
      await s.as(u.mechanic);
      expect((await pgError(ack(s, a))).code).toBe("42501"); // released
      await s.as(u.office);
      expect((await s.query<{ r: { outstanding: string[] } }>("select public.comm_alert_acknowledge($1, 'On it') as r", [a])).rows[0].r.outstanding).toEqual([]);
      expect(await events(s, a)).toContain("reassigned");
    });
  });

  it("unacknowledged Critical alerts escalate; original recipients stay responsible", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      const a = await raise(s, c, "maintenance.safety_restriction", "w1", [u.dispatcher]);
      expect((await housekeep(s, c, u.dispatcher)).escalated).toBe(0); // not due yet
      await s.asAdmin();
      await s.query("update public.alerts set escalation_due_at = now() - interval '1 minute' where id = $1", [a]);
      expect((await housekeep(s, c, u.dispatcher)).escalated).toBe(1);
      await s.asAdmin();
      const rec = (await s.query<{ user_id: string; reason: string; responsible: boolean }>(
        "select user_id, reason, responsible from public.alert_recipients where alert_id = $1 and released_at is null order by reason", [a])).rows;
      expect(rec).toEqual([{ user_id: u.dispatcher, reason: "designated", responsible: true }, { user_id: u.owner, reason: "escalation", responsible: true }]);
      const row = await alert(s, a);
      expect(row.escalation_level).toBe(1);
      expect(row.escalation_due_at).not.toBeNull();
      expect((await s.query("select critical, state from public.comm_notifications where user_id = $1 and title like 'Escalated:%'", [u.owner])).rows[0]).toEqual({ critical: true, state: "visible" });
      // The escalation recipient may acknowledge; escalation then stops.
      await s.as(u.owner);
      await ack(s, a);
      expect((await alert(s, a)).escalation_due_at).toBeNull();
    });
  });

  it("resolution notifies recipients with a link; informational alerts resolve quietly", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      const a = await raise(s, c, "dispatch.breakdown_report", "r1", [u.dispatcher, u.owner]);
      await s.as(u.office);
      expect((await pgError(s.query("select public.comm_alert_resolve($1, 'Fixed it')", [a]))).code).toBe("42501");
      await s.as(u.dispatcher);
      expect((await pgError(s.query("select public.comm_alert_resolve($1, '')", [a]))).message).toMatch(/how it was resolved/);
      await s.query("select public.comm_alert_resolve($1, 'Tow arranged; load reassigned')", [a]);
      const row = await alert(s, a);
      expect([row.status, row.resolved_by, row.resolution_note]).toEqual(["resolved", u.dispatcher, "Tow arranged; load reassigned"]);
      await s.asAdmin();
      const resolved = (await s.query<{ user_id: string; link: string }>("select user_id, link from public.comm_notifications where title like 'Resolved:%' and source_id = $1", [a])).rows;
      expect(resolved.map((r) => r.user_id).sort()).toEqual([u.dispatcher, u.owner].sort());
      expect(resolved[0].link).toBe(`/communications/alerts/${a}`);
      await s.as(u.dispatcher);
      expect((await pgError(s.query("select public.comm_alert_resolve($1, 'Again')", [a]))).message).toMatch(/already resolved/);
      // After resolution the same event key starts a new alert.
      expect(await raise(s, c, "dispatch.breakdown_report", "r1", [u.dispatcher])).not.toBe(a);

      const i = await raise(s, c, "dispatch.assignment_canceled", "x1", [u.driver]);
      await s.as(u.dispatcher);
      await s.query("select public.comm_alert_resolve($1, 'Reassigned to another load')", [i]);
      await s.asAdmin();
      expect((await s.query("select count(*)::int as n from public.comm_notifications where source_id = $1 and title like 'Resolved:%'", [i])).rows[0].n).toBe(0);
    });
  });

  it("Critical notifications ignore quiet hours and alert preferences; routine ones respect them", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      await s.as(u.dispatcher);
      await s.query("select public.comm_save_preferences($1::jsonb)", [JSON.stringify({ quiet_start: "00:00", quiet_end: "23:59", timezone: "UTC", notify_alert: false })]);
      const crit = await raise(s, c, "maintenance.safety_restriction", "w1", [u.dispatcher]);
      const routine = await raise(s, c, "documents.expired", "d1", [u.dispatcher]);
      await s.asAdmin();
      const n = (await s.query<{ source_id: string; state: string; critical: boolean }>("select source_id, state, critical from public.comm_notifications where user_id = $1", [u.dispatcher])).rows;
      expect(n.filter((x) => x.source_id === crit)).toEqual([{ source_id: crit, state: "visible", critical: true }]);
      expect(n.filter((x) => x.source_id === routine)).toEqual([]); // alert notifications turned off
    });
  });
});

describe("alert sources", () => {
  it("a safety-critical work order raises a Critical alert for dispatch and clearers (never drivers); clearing resolves it", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      await s.as(u.owner);
      const t = await insert(s, "trucks", { unit_number: "PLT-7", truck_type: "tri_axle_dump" });
      await s.as(u.mechanic);
      const wo = (await s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) as r",
        [JSON.stringify({ truck_id: t, title: "Brake chamber cracked", category: "brakes", urgency: "immediate", safety_critical: true })])).rows[0].r;
      await s.asAdmin();
      const a = (await s.query("select * from public.alerts where company_id = $1 and event_type = 'maintenance.safety_restriction'", [c])).rows[0];
      expect([a.priority, a.entity_id, a.title]).toEqual(["critical", t, "Truck PLT-7 restricted: Brake chamber cracked"]);
      const rec = (await s.query<{ user_id: string }>("select user_id from public.alert_recipients where alert_id = $1", [a.id])).rows.map((r) => r.user_id);
      expect(rec).toContain(u.dispatcher);
      expect(rec).toContain(u.owner);
      expect(rec).not.toContain(u.driver);
      // Drivers cannot read it.
      await s.as(u.driver);
      expect((await s.query("select id from public.alerts where id = $1", [a.id])).rowCount).toBe(0);
      // Canceling the work order resolves the alert.
      await s.as(u.owner);
      await s.query("select public.maintenance_set_status($1, 'canceled', 'Duplicate report')", [wo.id]);
      expect((await alert(s, a.id)).status).toBe("resolved");
    });
  });

  it("time-off alerts never reveal the category or comment; approval with conflicts alerts dispatch", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const { c, u } = await company(s);
      await s.asAdmin();
      await s.query("insert into public.employees (company_id, user_id, full_name) values ($1, $2, 'Pat Example')", [c, u.mechanic]);
      await s.as(u.mechanic);
      const r = (await s.query<{ r: { id: string } }>("select public.time_off_save($1::jsonb) as r",
        [JSON.stringify({ category: "bereavement", start_date: addDays(today, 5), end_date: addDays(today, 6), reason: "Family funeral" })])).rows[0].r;
      await s.asAdmin();
      const req = (await s.query("select * from public.alerts where company_id = $1 and event_type = 'time_off.requested'", [c])).rows[0];
      expect(JSON.stringify([req.title, req.detail])).not.toMatch(/bereavement|funeral/i);
      expect(req.title).toMatch(/^Time off requested: Pat Example/);
      await s.as(u.owner);
      await s.query("select public.time_off_decide($1, 'approved', 'OK')", [r.id]);
      expect((await alert(s, req.id)).status).toBe("resolved");
      const decided = (await s.query("select a.title from public.alerts a join public.alert_recipients r on r.alert_id = a.id where a.company_id = $1 and a.event_type = 'time_off.decided' and r.user_id = $2", [c, u.mechanic])).rows;
      expect(decided).toHaveLength(1);
      expect(decided[0].title).toMatch(/was approved$/);
    });
  });

  it("an announcement needing acknowledgment raises an 'all' alert that resolves when everyone acknowledges", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      await s.asAdmin();
      await s.query("insert into public.employees (company_id, user_id, full_name, department) values ($1, $2, 'Shop One', 'shop'), ($1, $3, 'Shop Two', 'shop')", [c, u.mechanic, u.driver]);
      await s.as(u.office);
      const ann = (await s.query<{ id: string }>("select public.comm_publish_announcement($1::jsonb) as id",
        [JSON.stringify({ title: "Lift inspection procedure", body: "Read before using the lift.", department: "shop", requires_ack: true })])).rows[0].id;
      await s.asAdmin();
      const a = (await s.query("select * from public.alerts where company_id = $1 and source_key = $2", [c, ann])).rows[0];
      expect(a.ack_scope).toBe("all");
      expect(await outstanding(s, a.id)).toEqual([u.mechanic, u.driver].sort());
      await s.as(u.mechanic);
      await s.query("select public.comm_announcement_receipt($1, true)", [ann]);
      expect(await outstanding(s, a.id)).toEqual([u.driver]);
      await s.as(u.driver);
      await s.query("select public.comm_announcement_receipt($1, true)", [ann]);
      expect((await alert(s, a.id)).status).toBe("resolved");
    });
  });
});

describe("tenancy", () => {
  it("another company can neither read nor act on alerts", async () => {
    await withSession(async (s) => {
      const { c, u } = await company(s);
      const a = await raise(s, c, "dispatch.breakdown_report", "r1", [u.dispatcher]);
      const other = await company(s);
      await s.as(other.u.owner);
      expect((await s.query("select id from public.alerts where id = $1", [a])).rowCount).toBe(0);
      expect((await s.query("select alert_id from public.alert_events where alert_id = $1", [a])).rowCount).toBe(0);
      expect((await pgError(ack(s, a))).code).toBe("P0002");
      expect((await pgError(s.query("select public.comm_alert_resolve($1, 'Not mine')", [a]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.comm_alert_reassign($1, $2, $3, 'Takeover')", [a, u.dispatcher, other.u.owner]))).code).toBe("P0002");
      // Counts only cover the caller's company.
      expect((await s.query<{ r: { open: number } }>("select public.comm_alert_counts() as r")).rows[0].r.open).toBe(0);
      await s.as(u.dispatcher);
      expect((await s.query<{ r: { open: number; critical: number; mine: number } }>("select public.comm_alert_counts() as r")).rows[0].r).toEqual({ open: 1, critical: 1, mine: 1 });
    });
  });
});
