import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const send = (s: Session, c: string, body: string, reply: string | null = null, key: string | null = null) =>
  s.query<{ r: { id: string; duplicate: boolean } }>("select public.comm_send($1, $2, $3, $4) as r", [c, body, reply, key]).then((r) => r.rows[0].r);
const visible = (s: Session, c: string) =>
  s.query<{ body: string }>("select body from public.messages where conversation_id = $1 and kind = 'text' order by created_at", [c]).then((r) => r.rows.map((x) => x.body));
const notes = async (s: Session, user: string) => {
  await s.asAdmin();
  return (await s.query<{ category: string; state: string; deferred_reason: string | null; title: string }>(
    "select category, state, deferred_reason, title from public.comm_notifications where user_id = $1 order by created_at", [user])).rows;
};

async function employee(s: Session, userId: string, department = "operations", driverId: string | null = null) {
  await s.asAdmin();
  return (await s.query<{ id: string }>("insert into public.employees (company_id, user_id, driver_id, full_name, department) values ($1, $2, $3, 'Comm Person', $4) returning id",
    [TOP_LINE, userId, driverId, department])).rows[0].id;
}

describe("direct and group messages", () => {
  it("direct conversations are reused, private, and stay inside the company", async () => {
    await withSession(async (s) => {
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("driver");
      const c = await s.createUser("office");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      expect((await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id).toBe(dm);
      const k = crypto.randomUUID();
      const m1 = await send(s, dm, "Hello Drew", null, k);
      expect((await send(s, dm, "Hello Drew", null, k)).id).toBe(m1.id); // double submit
      await s.as(b);
      expect(await visible(s, dm)).toEqual(["Hello Drew"]);
      await s.as(c);
      expect(await visible(s, dm)).toEqual([]);
      expect((await pgError(send(s, dm, "Intrude"))).code).toBe("42501");

      const other = await s.createCompany(`Other ${Math.random().toString(36).slice(2, 6)}`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect(await visible(s, dm)).toEqual([]);
      expect((await pgError(s.query("select public.comm_open_direct($1)", [a]))).code).toBe("P0002");
    });
  });

  it("new group members see only what is shared with them; removed members see nothing new and cannot post", async () => {
    await withSession(async (s) => {
      const lead = await s.createUser("dispatcher");
      const x = await s.createUser("driver");
      const y = await s.createUser("driver");
      const z = await s.createUser("mechanic");
      await s.as(lead);
      const g = (await s.query<{ id: string }>("select public.comm_create_group('', $1) as id", [[x]])).rows[0].id;
      await send(s, g, "Before Y joined");
      await s.as(x); // ordinary members may add coworkers to a group
      await s.query("select public.comm_add_members($1, $2, false)", [g, [y]]);
      await s.as(y);
      expect(await visible(s, g)).toEqual([]); // private by default
      await s.as(lead);
      await s.query("select public.comm_add_members($1, $2, true)", [g, [z]]); // a manager may share history
      await s.as(z);
      expect(await visible(s, g)).toEqual(["Before Y joined"]);
      await s.as(x);
      expect((await pgError(s.query("select public.comm_remove_member($1, $2)", [g, y]))).code).toBe("42501"); // members cannot remove
      await s.as(lead);
      await send(s, g, "Still in");
      await s.query("select public.comm_remove_member($1, $2, 'Moved crews')", [g, y]);
      await send(s, g, "After Y left");
      await s.as(y);
      expect(await visible(s, g)).toEqual(["Still in"]); // keeps what was visible, nothing after
      expect((await pgError(send(s, g, "Can I post?"))).code).toBe("42501");
      const events = await s.query<{ kind: string }>("select kind from public.conversation_events where conversation_id = $1 order by created_at", [g]);
      expect(events.rows.map((e) => e.kind)).toEqual(expect.arrayContaining(["created", "member_added", "member_removed"]));
    });
  });

  it("group titles: generated until set, renamed by managers only, and audited", async () => {
    await withSession(async (s) => {
      const lead = await s.createUser("dispatcher");
      const x = await s.createUser("driver");
      await s.as(lead);
      const g = (await s.query<{ id: string }>("select public.comm_create_group('', $1) as id", [[x]])).rows[0].id;
      const inbox = (await s.query<{ r: Array<{ id: string; title: string }> }>("select public.comm_inbox() as r")).rows[0].r;
      expect(inbox.find((i) => i.id === g)!.title).toBe("Test driver");
      await s.as(x);
      expect((await pgError(s.query("select public.comm_set_title($1, 'Night crew')", [g]))).code).toBe("42501");
      await s.as(lead);
      await s.query("select public.comm_set_title($1, 'Night crew')", [g]);
      expect((await s.query<{ r: Array<{ id: string; title: string }> }>("select public.comm_inbox() as r")).rows[0].r.find((i) => i.id === g)!.title).toBe("Night crew");
      const ev = await s.query<{ details: { from: string; to: string } }>("select details from public.conversation_events where conversation_id = $1 and kind = 'title_changed'", [g]);
      expect(ev.rows[0].details.to).toBe("Night crew");
    });
  });

  it("edits within the window keep the previous text for administrators; deletions are recorded", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("driver");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      const m = await send(s, dm, "Load at 7");
      await s.query("select public.comm_edit_message($1, 'Load at 8')", [m.id]);
      await s.as(b);
      expect((await pgError(s.query("select public.comm_edit_message($1, 'Hacked')", [m.id]))).code).toBe("42501");
      const row = (await s.query("select body, edited_at from public.messages where id = $1", [m.id])).rows[0];
      expect(row.body).toBe("Load at 8");
      expect(row.edited_at).not.toBeNull();
      expect((await s.query("select * from public.message_revisions where message_id = $1", [m.id])).rowCount).toBe(0); // not for members
      await s.as(owner);
      expect((await s.query<{ old_body: string }>("select old_body from public.message_revisions where message_id = $1", [m.id])).rows[0].old_body).toBe("Load at 7");
      // The window is fixed at 5 minutes from creation; earlier edits never restart it.
      await s.asAdmin();
      await s.query("update public.conversation_members set history_from = history_from - interval '1 hour' where conversation_id = $1", [dm]);
      await s.query("update public.messages set created_at = created_at - interval '5 minutes 1 second' where id = $1", [m.id]);
      await s.as(owner);
      await s.query("select public.comm_save_settings('{\"edit_window_minutes\": 600}'::jsonb)"); // the old setting no longer widens it
      await s.as(a);
      expect((await pgError(s.query("select public.comm_edit_message($1, 'Too late')", [m.id]))).message).toMatch(/5 minutes/);
      expect((await pgError(s.query("select public.comm_delete_message($1)", [m.id]))).message).toMatch(/5 minutes/);
      expect((await pgError(s.query("select public.comm_delete_message($1, 'I want it gone')", [m.id]))).message).toMatch(/5 minutes/); // a reason is no bypass
      await s.as(owner); // managers may remove it after the window, with a reason; the text is kept for administrators
      expect((await pgError(s.query("select public.comm_delete_message($1)", [m.id]))).message).toMatch(/reason/);
      await s.query("select public.comm_delete_message($1, 'Contained a customer phone number')", [m.id]);
      const del = (await s.query("select body, deleted_at from public.messages where id = $1", [m.id])).rows;
      expect(del).toHaveLength(0); // the owner is not a member: they cannot read it
      await s.as(b);
      expect((await s.query("select body, deleted_at, removal_kind from public.messages where id = $1", [m.id])).rows[0]).toMatchObject({ body: "", removal_kind: "manager" });
      await s.as(owner);
      const revs = (await s.query<{ action: string; reason: string }>("select action, reason from public.message_revisions where message_id = $1 order by created_at", [m.id])).rows;
      expect(revs).toEqual([{ action: "edited", reason: "" }, { action: "deleted", reason: "Contained a customer phone number" }]);
      const audit = (await s.query<{ details: Record<string, unknown> }>("select details from public.audit_events where action = 'comm_message_removed' and entity_id = $1", [m.id])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].details.reason).toBe("Contained a customer phone number");
      expect(JSON.stringify(audit[0].details)).not.toContain("Load at"); // the audit record never holds message text
    });
  });

  it("authors delete their own message within 5 minutes; a tombstone remains", async () => {
    await withSession(async (s) => {
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("driver");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      const m = await send(s, dm, "Wrong truck number");
      await s.query("select public.comm_delete_message($1)", [m.id]);
      await s.as(b);
      expect((await s.query("select body, removal_kind, deleted_at is not null as gone from public.messages where id = $1", [m.id])).rows[0]).toEqual({ body: "", removal_kind: "author", gone: true });
      const other = await send(s, dm, "Mine, not yours");
      await s.as(a);
      expect((await pgError(s.query("select public.comm_delete_message($1, 'not mine to remove')", [other.id]))).code).toBe("42501");
    });
  });

  it("threads stay one level deep; receipts show delivered and read", async () => {
    await withSession(async (s) => {
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("driver");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      const root = await send(s, dm, "Where is truck 12?");
      await s.as(b);
      const r1 = await send(s, dm, "At the quarry", root.id);
      await s.as(a);
      const r2 = await send(s, dm, "Thanks", r1.id);
      const parents = await s.query<{ id: string; reply_to_id: string | null }>("select id, reply_to_id from public.messages where id = any($1)", [[r1.id, r2.id]]);
      expect(parents.rows.every((p) => p.reply_to_id === root.id)).toBe(true);
      let rc = (await s.query<{ r: Record<string, { delivered: number; read: number }> }>("select public.comm_receipts($1) as r", [dm])).rows[0].r;
      expect(rc[r2.id]).toMatchObject({ delivered: 0, read: 0 });
      await s.as(b);
      await s.query("select public.comm_inbox()");
      await s.as(a);
      rc = (await s.query<{ r: Record<string, { delivered: number; read: number }> }>("select public.comm_receipts($1) as r", [dm])).rows[0].r;
      expect(rc[r2.id]).toMatchObject({ delivered: 1, read: 0 });
      await s.as(b);
      await s.query("select public.comm_mark_read($1)", [dm]);
      await s.as(a);
      rc = (await s.query<{ r: Record<string, { delivered: number; read: number }> }>("select public.comm_receipts($1) as r", [dm])).rows[0].r;
      expect(rc[r2.id]).toMatchObject({ delivered: 1, read: 1 });
    });
  });
});

describe("notifications, mutes, quiet hours and drivers on delivery", () => {
  it("muted conversations do not notify until the mute expires; quiet hours defer and release", async () => {
    await withSession(async (s) => {
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("office");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      await s.as(b);
      await s.query("select public.comm_mute($1, 60)", [dm]);
      await s.as(a);
      await send(s, dm, "While muted");
      expect(await notes(s, b)).toHaveLength(0);
      await s.query("update public.conversation_members set muted_until = now() - interval '1 minute' where conversation_id = $1 and user_id = $2", [dm, b]);
      await s.as(a);
      await send(s, dm, "After the mute");
      expect((await notes(s, b)).map((n) => n.state)).toEqual(["visible"]);

      // Quiet hours covering now (the whole day except one minute).
      await s.as(b);
      await s.query("select public.comm_save_preferences($1::jsonb)", [JSON.stringify({ quiet_start: "00:00", quiet_end: "23:59", timezone: "UTC" })]);
      await s.as(a);
      await send(s, dm, "During quiet hours");
      const n = await notes(s, b);
      const quiet = n.filter((x) => x.deferred_reason === "quiet_hours");
      if (new Date().getUTCHours() === 23 && new Date().getUTCMinutes() === 59) return; // the one minute outside
      expect(quiet.map((x) => x.state)).toEqual(["deferred"]);
      await s.query("update public.comm_notifications set release_at = now() - interval '1 second' where user_id = $1 and state = 'deferred'", [b]);
      await s.as(b);
      expect((await s.query<{ n: number }>("select public.comm_release_deferred() as n")).rows[0].n).toBe(1);
    });
  });

  it("drivers on an active delivery get routine notifications deferred and ONE catch-up afterwards; never Available automatically", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const driverUser = await s.createUser("driver");
      const f = await fleet(s, owner, today);
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $1 where id = $2", [driverUser, f.d1]);
      const order = await scheduledOrder(s, owner, today, addDays(today, 1));
      const load = await planLoad(s, order.id, today, "00:01", "23:59");
      await s.as(dispatcher);
      const asg = await assign(s, load.load_id, f.t1, null, f.d1);
      const status = async () => { await s.asAdmin(); return (await s.query<{ w: string }>("select private.comm_work_status($1, $2) as w", [TOP_LINE, driverUser])).rows[0].w; };
      const now = new Date();
      if (now.getHours() === 0 && now.getMinutes() < 2) return; // outside the load window
      expect(await status()).toBe("active_delivery");

      await s.as(dispatcher);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [driverUser])).rows[0].id;
      for (const t of ["One", "Two", "Three"]) await send(s, dm, t);
      expect((await notes(s, driverUser)).map((n) => n.deferred_reason)).toEqual(["active_delivery", "active_delivery", "active_delivery"]);
      await s.as(driverUser);
      expect((await s.query<{ n: number }>("select public.comm_release_deferred() as n")).rows[0].n).toBe(0); // still delivering
      expect(await visible(s, dm)).toEqual(["One", "Two", "Three"]); // the messages themselves are never held back

      await s.query("select public.comm_set_presence('busy')"); // the driver chose Busy
      await s.as(dispatcher);
      await s.query("select public.cancel_assignment($1, 'Load moved')", [asg]);
      expect(await status()).toBe("unknown"); // not "available": no schedules exist
      await s.as(driverUser);
      expect((await s.query<{ n: number }>("select public.comm_release_deferred() as n")).rows[0].n).toBe(1);
      expect((await s.query<{ n: number }>("select public.comm_release_deferred() as n")).rows[0].n).toBe(0); // only once
      const n = await notes(s, driverUser);
      expect(n.filter((x) => x.category === "catch_up")).toHaveLength(1);
      expect(n.filter((x) => x.state === "superseded")).toHaveLength(3);
      // Presence is never changed by the delivery ending.
      await s.asAdmin();
      expect((await s.query("select private.comm_presence($1, $2) as p", [TOP_LINE, driverUser])).rows[0].p).toBe("busy");
    });
  });

  it("work status: approved leave is Out of office; pending is not; leave category is never exposed", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const u = await s.createUser("mechanic");
      const emp = await employee(s, u, "shop");
      await s.as(owner);
      const r = (await s.query<{ r: { id: string } }>("select public.time_off_save($1::jsonb) as r", [JSON.stringify({ employee_id: emp, category: "sick", start_date: today, end_date: today, reason: "Private" })])).rows[0].r;
      const dir = async () => (await s.query<{ r: Array<{ user_id: string; work_status: string }> }>("select public.comm_directory() as r")).rows[0].r.find((x) => x.user_id === u)!;
      expect((await dir()).work_status).toBe("unknown");
      await s.query("select public.time_off_decide($1, 'approved', '')", [r.id]);
      const d = await dir();
      expect(d.work_status).toBe("out_of_office");
      expect(JSON.stringify(d)).not.toMatch(/sick|Private/);
      await s.query("select public.time_off_cancel($1, 'Back')", [r.id]);
      expect((await dir()).work_status).toBe("unknown");
    });
  });
});

describe("channels, announcements and search", () => {
  it("channels need the manage permission; members post and reply; others cannot read", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const shop1 = await s.createUser("mechanic");
      const driverUser = await s.createUser("driver");
      await employee(s, shop1, "shop");
      await s.as(driverUser);
      expect((await pgError(s.query("select public.comm_create_channel('Shop', '', 'shop', true, '{}')"))).code).toBe("42501");
      await s.as(office);
      const ch = (await s.query<{ id: string }>("select public.comm_create_channel('Shop floor', 'Shop news', 'shop', true, '{}') as id")).rows[0].id;
      const post = await send(s, ch, "Bay 2 is closed today");
      await s.as(shop1); // added because of the department
      await send(s, ch, "Noted", post.id);
      expect(await visible(s, ch)).toEqual(["Bay 2 is closed today", "Noted"]);
      await s.as(driverUser);
      expect(await visible(s, ch)).toEqual([]);
    });
  });

  it("department announcements reach that department; acknowledgment only when asked", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const shopUser = await s.createUser("mechanic");
      const opsUser = await s.createUser("driver");
      await employee(s, shopUser, "shop");
      await employee(s, opsUser, "operations");
      await s.as(opsUser);
      expect((await pgError(s.query("select public.comm_publish_announcement('{\"title\":\"Hi all\",\"body\":\"x\"}'::jsonb)"))).code).toBe("42501");
      await s.as(office);
      const a = (await s.query<{ id: string }>("select public.comm_publish_announcement($1::jsonb) as id", [JSON.stringify({ title: "New lift inspection", body: "Read the procedure.", department: "shop", requires_ack: true })])).rows[0].id;
      const b = (await s.query<{ id: string }>("select public.comm_publish_announcement($1::jsonb) as id", [JSON.stringify({ title: "Holiday hours", body: "Closed Friday." })])).rows[0].id;
      await s.as(opsUser);
      const seen = (await s.query<{ id: string }>("select id from public.announcements where id = any($1)", [[a, b]])).rows.map((r) => r.id);
      expect(seen).toEqual([b]);
      expect((await pgError(s.query("select public.comm_announcement_receipt($1, true)", [b]))).message).toMatch(/does not ask/);
      await s.as(shopUser);
      await s.query("select public.comm_announcement_receipt($1, true)", [a]);
      await s.as(office);
      expect((await s.query("select acknowledged_at from public.announcement_receipts where announcement_id = $1", [a])).rows[0].acknowledged_at).not.toBeNull();
    });
  });

  it("search returns only what the caller may read; administrative search needs a reason and is audited", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("driver");
      const c = await s.createUser("office");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      await send(s, dm, "Gate code is 4471 zebra");
      await s.as(c);
      expect((await s.query<{ r: { messages: unknown[] } }>("select public.comm_search('zebra') as r")).rows[0].r.messages).toEqual([]);
      await s.as(b);
      expect((await s.query<{ r: { messages: unknown[] } }>("select public.comm_search('zebra') as r")).rows[0].r.messages).toHaveLength(1);
      await s.as(c);
      expect((await pgError(s.query("select public.comm_admin_search('zebra', 'Investigating a complaint')"))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(s.query("select public.comm_admin_search('zebra', '')"))).message).toMatch(/reason/);
      const hits = (await s.query<{ r: unknown[] }>("select public.comm_admin_search('zebra', 'Investigating a complaint') as r")).rows[0].r;
      expect(hits).toHaveLength(1);
      await s.asAdmin();
      expect((await s.query("select 1 from public.audit_events where action = 'comm_admin_search' and actor_id = $1", [owner])).rowCount).toBe(1);
    });
  });
});
