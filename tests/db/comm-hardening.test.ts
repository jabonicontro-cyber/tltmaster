// Communications hardening (20261108000100): the 14-day message content retention
// (read-time and purge, attachments, revisions, search, legal hold, audit), the
// scheduled all-companies housekeeping (service role only), and demo sample content.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const hasStorage = (await pool.query("select to_regclass('storage.objects') is not null as ok")).rows[0].ok as boolean;

const send = (s: Session, c: string, body: string, reply: string | null = null) =>
  s.query<{ r: { id: string } }>("select public.comm_send($1, $2, $3) as r", [c, body, reply]).then((r) => r.rows[0].r);
const bodies = (s: Session, c: string) =>
  s.query<{ body: string }>("select body from public.messages where conversation_id = $1 and kind = 'text' order by created_at", [c]).then((r) => r.rows.map((x) => x.body));
/** Move a message (and the members' history windows) back in time, as the clock would. */
async function age(s: Session, conv: string, ids: string[], days: number) {
  await s.asAdmin();
  await s.query("update public.conversation_members set history_from = history_from - make_interval(days => $2) where conversation_id = $1", [conv, days + 1]);
  await s.query("update public.messages set created_at = created_at - make_interval(days => $2) where id = any($1::uuid[])", [ids, days]);
}
async function retention(s: Session) {
  await s.asAdmin();
  return (await s.query<{ n: number }>("select private.comm_apply_retention($1) as n", [TOP_LINE])).rows[0].n;
}

describe("message content retention (14 days)", () => {
  it("content older than 14 days is unreadable at once and purged by the job; replies and edits never extend it", async () => {
    await withSession(async (s) => {
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("driver");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      const old = await send(s, dm, "Gate code 4471");
      await s.query("select public.comm_edit_message($1, 'Gate code 4472')", [old.id]);
      await s.as(b);
      const reply = await send(s, dm, "Thanks, got the gate code", old.id);
      await age(s, dm, [old.id], 15);
      await s.as(b);
      // Read time: hidden before the purge runs, in the thread, the inbox and search.
      expect(await bodies(s, dm)).toEqual(["Thanks, got the gate code"]);
      const found = (await s.query<{ r: { messages: Array<{ id: string }> } }>("select public.comm_search('gate code') as r")).rows[0].r.messages.map((m) => m.id);
      expect(found).toEqual([reply.id]);
      await s.as(a);
      expect((await pgError(s.query("select public.comm_edit_message($1, 'Gate code 9')", [old.id]))).code).toBe("P0002");

      expect(await retention(s)).toBeGreaterThanOrEqual(1);
      const row = (await s.query("select body, expired_at is not null as expired, pinned from public.messages where id = $1", [old.id])).rows[0];
      expect(row).toEqual({ body: "", expired: true, pinned: false });
      expect((await s.query("select 1 from public.message_revisions where message_id = $1", [old.id])).rowCount).toBe(0);
      expect((await s.query("select body from public.messages where id = $1", [reply.id])).rows[0].body).toBe("Thanks, got the gate code");
      const audit = (await s.query<{ details: Record<string, unknown>; summary: string }>(
        "select details, summary from public.audit_events where company_id = $1 and action = 'comm_retention' order by occurred_at desc limit 1", [TOP_LINE])).rows[0];
      expect(audit.summary).toMatch(/Retention expired \d+ messages/);
      expect(JSON.stringify(audit)).not.toContain("4471");
      // Administrative search does not reach expired content either.
      const owner = await s.createUser("owner");
      await s.as(owner);
      const admin = (await s.query<{ r: Array<{ id: string }> }>("select public.comm_admin_search('4472', 'Customer complaint review') as r")).rows[0].r;
      expect(admin).toEqual([]);
    });
  });

  it("a legal hold keeps content readable and stops the purge; lifting it lets the job expire the backlog", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("driver");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      const m = await send(s, dm, "Incident at the scale house");
      await age(s, dm, [m.id], 30);
      await s.as(owner);
      await s.query("select public.comm_save_settings('{\"legal_hold\": true}'::jsonb)");
      await s.as(b);
      expect(await bodies(s, dm)).toEqual(["Incident at the scale house"]);
      await retention(s);
      expect((await s.query("select body from public.messages where id = $1", [m.id])).rows[0].body).toBe("Incident at the scale house");
      // A manager removal under hold keeps the text for administrators (no erasure).
      await s.as(owner);
      await s.query("select public.comm_delete_message($1, 'Sensitive detail, keep for counsel')", [m.id]);
      expect((await s.query<{ old_body: string }>("select old_body from public.message_revisions where message_id = $1", [m.id])).rows[0].old_body).toBe("Incident at the scale house");
      await s.query("select public.comm_save_settings('{\"legal_hold\": false}'::jsonb)");
      await retention(s);
      await s.asAdmin();
      expect((await s.query("select 1 from public.message_revisions where message_id = $1", [m.id])).rowCount).toBe(0);
      expect((await s.query("select count(*)::int as n from public.audit_events where action = 'comm_message_removed' and entity_id = $1", [m.id])).rows[0].n).toBe(1); // audit kept
    });
  });

  it.skipIf(!hasStorage)("attachments of expired messages become unreadable and are listed for file removal", async () => {
    await withSession(async (s) => {
      const a = await s.createUser("dispatcher");
      const b = await s.createUser("driver");
      await s.as(a);
      const dm = (await s.query<{ id: string }>("select public.comm_open_direct($1) as id", [b])).rows[0].id;
      const key = randomUUID();
      const r = (await s.query<{ r: { attachment_id: string; object_path: string } }>("select public.comm_begin_attachment($1, $2, 'ticket.jpg', 'image/jpeg', 2048, $3) as r",
        [dm, key, createHash("sha256").update(key).digest("hex")])).rows[0].r;
      await s.query("insert into storage.objects (bucket_id, name, owner_id, metadata) values ('comm-attachments', $1, auth.uid()::text, $2::jsonb)", [r.object_path, JSON.stringify({ size: 2048, mimetype: "image/jpeg" })]);
      await s.query("select public.comm_confirm_attachment($1)", [r.attachment_id]);
      const msg = (await s.query<{ r: { id: string } }>("select public.comm_send_files($1, 'Ticket photo', null, null, $2::uuid[]) as r", [dm, [r.attachment_id]])).rows[0].r;
      await s.as(b);
      expect((await s.query("select 1 from storage.objects where name = $1", [r.object_path])).rowCount).toBe(1);
      await age(s, dm, [msg.id], 15);
      await s.as(b); // read time: gone before the purge
      expect((await s.query("select 1 from storage.objects where name = $1", [r.object_path])).rowCount).toBe(0);
      expect((await s.query("select 1 from public.message_attachments where id = $1", [r.attachment_id])).rowCount).toBe(0);
      await retention(s);
      expect((await s.query("select status from public.message_attachments where id = $1", [r.attachment_id])).rows[0].status).toBe("expired");
      // The scheduled job lists the file for removal through the Storage API, then records it.
      await s.query("set local role service_role");
      const files = (await s.query<{ attachment_id: string }>("select attachment_id from public.comm_expired_attachment_files(1000)")).rows.map((x) => x.attachment_id);
      expect(files).toContain(r.attachment_id);
      expect((await s.query<{ n: number }>("select public.comm_mark_attachment_files_removed($1::uuid[]) as n", [[r.attachment_id]])).rows[0].n).toBe(1);
      expect((await s.query("select attachment_id from public.comm_expired_attachment_files(1000) where attachment_id = $1", [r.attachment_id])).rowCount).toBe(0);
    });
  });
});

describe("scheduled housekeeping", () => {
  it("runs for every company as the service role and is closed to app users", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.comm_housekeeping_all()"))).code).toBe("42501");
      expect((await pgError(s.query("select * from public.comm_expired_attachment_files(10)"))).code).toBe("42501");
      expect((await pgError(s.query("select public.comm_mark_attachment_files_removed('{}')"))).code).toBe("42501");
      await s.asAdmin();
      await s.query("set local role service_role");
      const r = (await s.query<{ r: { companies: number; failed: unknown[] } }>("select public.comm_housekeeping_all() as r")).rows[0].r;
      expect(r.companies).toBeGreaterThanOrEqual(1);
      expect(r.failed).toEqual([]);
    });
  });
});

describe("demo sample content", () => {
  it("only demo companies get fictional sample channel content, never with platform operators as members", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.comm_seed_demo_samples()"))).code).toBe("42501");
      const demo = await s.createCompany(`Sample Demo ${randomUUID().slice(0, 6)}`);
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [demo]);
      const demoOwner = await s.createUser("owner", { companyId: demo });
      const operator = await s.createUser("owner", { companyId: demo });
      await s.asAdmin();
      await s.query("insert into private.platform_admins (user_id, note) values ($1, 'test operator')", [operator]);
      await s.query("update public.profiles set active_company_id = $1 where id in ($2, $3)", [demo, demoOwner, operator]);
      await s.as(operator);
      expect((await s.query<{ n: number }>("select public.comm_seed_demo_samples() as n")).rows[0].n).toBeGreaterThan(0);
      expect((await s.query<{ n: number }>("select public.comm_seed_demo_samples() as n")).rows[0].n).toBe(0); // idempotent
      await s.asAdmin();
      const conv = (await s.query<{ id: string }>("select id from public.conversations where company_id = $1 and title = 'Dispatch desk'", [demo])).rows[0].id;
      const mem = (await s.query<{ user_id: string }>("select user_id from public.conversation_members where conversation_id = $1", [conv])).rows.map((x) => x.user_id);
      expect(mem).toEqual([demoOwner]);
      const msgs = (await s.query<{ body: string }>("select body from public.messages where conversation_id = $1", [conv])).rows.map((x) => x.body);
      expect(msgs.every((b) => b.startsWith("Sample"))).toBe(true);
      // A prospect owner added later (the operator's way) joins the sample channel at once.
      const later = await s.createUser(null, { membership: false });
      await s.asAdmin();
      await s.query("set local role service_role");
      await s.query("select public.platform_prospect_demo_add_owner($1, $2, null)", [demo, later]);
      await s.asAdmin();
      const joined = (await s.query("select 1 from public.conversation_members where conversation_id = $1 and user_id = $2 and left_at is null", [conv, later])).rowCount;
      expect(joined).toBe(1);
    });
  });
});
