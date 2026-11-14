// Sample ticket photos for demo customers (UX13, 20261120020900), at the database layer: only the owner of a demo
// company may list targets, reserve and attach; the reservation is idempotent per ticket and stored only at its own
// path (storage policy); attaching checks the stored object; a driver's own photo is never touched; a real company is
// refused; the rollback removes the functions. Applied inside the test transaction, so it runs anywhere.
// Needs the Supabase Storage schema (scripts/dev-stack: DEV_STORAGE=1).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const hasStorage = (await pool.query("select to_regclass('storage.objects') is not null as ok")).rows[0].ok as boolean;
const migration = readFileSync(join(__dirname, "../../supabase/migrations/20261120020900_demo_ticket_photo_samples.sql"), "utf8");
const rollback = readFileSync(join(__dirname, "../../supabase/rollbacks/20261120020900_demo_ticket_photo_samples.down.sql"), "utf8")
  .replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Begin = { attachment_id: string | null; object_path: string | null; status: string };
const begin = async (s: Session, ticket: string, size = 4096) =>
  (await s.query<{ r: Begin }>("select public.demo_ticket_photo_begin($1, 'image/jpeg', $2, $3) r", [ticket, size, sha("sample")])).rows[0].r;
const attach = async (s: Session, id: string) => (await s.query<{ r: boolean }>("select public.demo_ticket_photo_attach($1) r", [id])).rows[0].r;
/** What the storage server does on upload: insert the object row as the caller (policies apply). */
const putObject = (s: Session, path: string, size = 4096) =>
  s.query("insert into storage.objects (bucket_id, name, owner_id, metadata) values ('ticket-photos', $1, auth.uid()::text, $2::jsonb)", [path, JSON.stringify({ size, mimetype: "image/jpeg" })]);

/** Top Line as a demo inside the transaction, its owner, and a confirmed ticket a driver entered (with a photo slot). */
async function world(s: Session) {
  await s.asAdmin();
  await s.query(migration);
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const owner = await s.createUser("owner");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00");
  const a1 = await assign(s, load.load_id, f.t1, null, f.d1);
  const driver = await s.createUser("driver");
  await s.as(office);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driver]);
  await s.as(driver);
  const t = (await s.query<{ r: { ticket_id: string; ticket_number: string } }>("select public.driver_submit_ticket($1::jsonb) r", [JSON.stringify({
    assignment_id: a1, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30", quantity: "20", unit_code: "ton",
    external_reference: `SC-${randomUUID().slice(0, 8)}`, submission_key: randomUUID(),
  })])).rows[0].r;
  await s.as(office);
  await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
  await s.asAdmin();
  await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [TOP_LINE]);
  return { office, owner, driver, a1, ticket: t.ticket_id, ticketNumber: t.ticket_number, order: order.id };
}

describe.skipIf(!hasStorage)("demo sample ticket photos", () => {
  it("lets a demo owner reserve, store and attach one sample photo per ticket, checking the stored file", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.owner);
      const targets = (await s.query<{ r: Array<{ ticket_id: string }> }>("select public.demo_ticket_photo_targets() r")).rows[0].r;
      expect(targets.map((t) => t.ticket_id)).toContain(w.ticket);
      const r = await begin(s, w.ticket);
      expect(r.status).toBe("pending");
      expect(r.object_path).toMatch(new RegExp(`^${TOP_LINE}/ticket-photos/${r.attachment_id}\\.jpg$`));
      expect(await begin(s, w.ticket)).toEqual(r); // the same reservation on a repeat

      // Attaching needs the stored file, of the declared size.
      expect((await pgError(attach(s, r.attachment_id!))).message).toMatch(/did not arrive/);
      // The storage policy accepts only the reserved path.
      expect((await pgError(putObject(s, `${TOP_LINE}/ticket-photos/${randomUUID()}.jpg`))).code).toBe("42501");
      await putObject(s, r.object_path!, 4095);
      expect((await pgError(attach(s, r.attachment_id!))).message).toMatch(/does not match/);
      await s.asAdmin();
      await s.query("update storage.objects set metadata = jsonb_set(metadata, '{size}', '4096') where bucket_id = 'ticket-photos' and name = $1", [r.object_path]);
      await s.as(w.owner);
      expect(await attach(s, r.attachment_id!)).toBe(true);
      expect(await attach(s, r.attachment_id!)).toBe(false); // already attached: nothing more

      const row = (await s.query<{ status: string; ticket_id: string; ticket_number: string }>("select status, ticket_id, ticket_number from public.ticket_attachments where id = $1", [r.attachment_id])).rows[0];
      expect(row).toEqual({ status: "attached", ticket_id: w.ticket, ticket_number: w.ticketNumber });
      // The ticket's customer is covered now; a ticket with a photo is not a target and gets no second one.
      expect((await s.query<{ r: Array<{ ticket_id: string }> }>("select public.demo_ticket_photo_targets() r")).rows[0].r.map((t) => t.ticket_id)).not.toContain(w.ticket);
      expect((await begin(s, w.ticket)).status).toBe("attached");
      const summary = (await s.query<{ summary: string }>("select summary from public.audit_events where entity_id = $1 and action = 'ticket_photo.attached' order by occurred_at desc limit 1", [w.order])).rows[0].summary;
      expect(summary).toMatch(/^Sample ticket photo \(demo, fictional\) attached to ticket /);
    });
  });

  it("never touches a driver's own photo and refuses anyone but a demo owner, and real companies", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      // A driver's own pending photo on that load: not a sample, never attached by these functions.
      await s.asAdmin();
      await s.query("update public.companies set is_demo = false, demo_kind = null where id = $1", [TOP_LINE]);
      await s.as(w.driver);
      const own = (await s.query<{ r: { attachment_id: string } }>("select public.driver_begin_ticket_photo($1, $2, 'image/jpeg', 100, $3) r", [w.a1, randomUUID(), sha("own")])).rows[0].r;
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [TOP_LINE]);
      await s.as(w.owner);
      expect((await pgError(attach(s, own.attachment_id))).code).toBe("42501");
      // Office staff of the demo, and drivers: not the owner.
      for (const who of [w.office, w.driver]) {
        await s.as(who);
        expect((await pgError(s.query("select public.demo_ticket_photo_targets()"))).code).toBe("42501");
        expect((await pgError(begin(s, w.ticket))).code).toBe("42501");
      }
      // A real company (is_demo false): refused for its owner too.
      await s.asAdmin();
      await s.query("update public.companies set is_demo = false, demo_kind = null where id = $1", [TOP_LINE]);
      await s.as(w.owner);
      expect((await pgError(s.query("select public.demo_ticket_photo_targets()"))).code).toBe("42501");
      expect((await pgError(begin(s, w.ticket))).code).toBe("42501");
      // Another company's demo owner cannot reach this ticket.
      const other = await s.createCompany("Other Demo (test)");
      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [other]);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [other, otherOwner]);
      await s.as(otherOwner);
      expect((await pgError(begin(s, w.ticket))).message).toMatch(/Ticket not found/);
      expect((await s.query<{ r: unknown[] }>("select public.demo_ticket_photo_targets() r")).rows[0].r).toEqual([]);
    });
  });

  it("the rollback removes the functions and keeps attached sample photos", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.owner);
      const r = await begin(s, w.ticket);
      await putObject(s, r.object_path!);
      await attach(s, r.attachment_id!);
      await s.asAdmin();
      await s.query(rollback);
      expect((await s.query("select 1 from pg_proc where proname like 'demo_ticket_photo%'")).rowCount).toBe(0);
      expect((await s.query("select 1 from public.ticket_attachments where id = $1 and status = 'attached'", [r.attachment_id])).rowCount).toBe(1);
    });
  });
});
