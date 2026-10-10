// Ticket photos at the database layer: reserving an upload, the storage.objects
// policies (insert only to the reserved path, read only attached photos of the
// company with tickets.view), confirmation, attaching inside the driver ticket
// submission (idempotent), corrections and voids, guards and abandoned uploads.
// Needs the Supabase Storage schema (scripts/dev-stack: DEV_STORAGE=1).
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const hasStorage = (await pool.query("select to_regclass('storage.objects') is not null as ok")).rows[0].ok as boolean;
if (!hasStorage) console.warn("Supabase Storage is not installed in this database: ticket photo tests are skipped. Start it with DEV_STORAGE=1 scripts/dev-stack/stack.sh up.");

type Row = Record<string, unknown>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const begin = async (s: Session, assignment: string, key = randomUUID(), mime = "image/jpeg", size = 2048, hash = sha(key)) =>
  (await s.query<{ r: { attachment_id: string; object_path: string; status: string } }>("select public.driver_begin_ticket_photo($1, $2, $3, $4, $5) as r", [assignment, key, mime, size, hash])).rows[0].r;
/** What the storage server does on upload: insert the object row as the caller (policies apply). */
const putObject = (s: Session, path: string, size = 2048, mime = "image/jpeg") =>
  s.query("insert into storage.objects (bucket_id, name, owner_id, metadata) values ('ticket-photos', $1, auth.uid()::text, $2::jsonb)", [path, JSON.stringify({ size, mimetype: mime })]);
const confirm = (s: Session, id: string) => s.query("select public.driver_confirm_ticket_photo($1)", [id]);
const submit = async (s: Session, p: Row) =>
  (await s.query<{ r: { ticket_id: string; ticket_number: string; created: boolean; photos: number } }>("select public.driver_submit_ticket($1::jsonb) as r", [JSON.stringify(p)])).rows[0].r;
const canSee = async (s: Session, path: string) => (await s.query("select 1 from storage.objects where bucket_id = 'ticket-photos' and name = $1", [path])).rowCount === 1;

async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const past = await planLoad(s, order.id, yesterday, "07:00", "09:00");
  const a1 = await assign(s, past.load_id, f.t1, null, f.d1);
  const other = await planLoad(s, order.id, yesterday, "10:00", "12:00");
  const a2 = await assign(s, other.load_id, f.t2, null, f.d2);
  const tomorrow = await planLoad(s, order.id, addDays(today, 1), "07:00", "09:00");
  const a3 = await assign(s, tomorrow.load_id, f.t1, null, f.d1);
  const driver1 = await s.createUser("driver");
  const driver2 = await s.createUser("driver");
  await s.as(office);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driver1]);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d2, driver2]);
  const ticket = (extra: Row = {}) => ({
    assignment_id: a1, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30",
    quantity: "20", unit_code: "ton", external_reference: `SC-${randomUUID().slice(0, 8)}`, submission_key: randomUUID(), ...extra,
  });
  return { today, yesterday, office, f, order, a1, a2, a3, driver1, driver2, ticket };
}

/** Reserve, store and confirm one photo as the current driver. */
async function uploaded(s: Session, assignment: string) {
  const r = await begin(s, assignment);
  await putObject(s, r.object_path);
  await confirm(s, r.attachment_id);
  return r;
}

describe.skipIf(!hasStorage)("reserving and storing a photo", () => {
  it("reserves a company-scoped path for the driver's own load, idempotently, with limits", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const key = randomUUID();
      const r = await begin(s, w.a1, key);
      expect(r.status).toBe("pending");
      expect(r.object_path).toMatch(new RegExp(`^00000000-0000-4000-8000-000000000001/ticket-photos/${r.attachment_id}\\.jpg$`));
      expect(await begin(s, w.a1, key)).toEqual(r);

      expect((await pgError(begin(s, w.a2))).code).toBe("42501"); // another driver's load
      expect((await pgError(begin(s, w.a3))).message).toMatch(/two days ago to today/); // tomorrow
      expect((await pgError(begin(s, w.a1, randomUUID(), "image/gif"))).message).toMatch(/JPEG, PNG or WebP/);
      expect((await pgError(begin(s, w.a1, randomUUID(), "image/jpeg", 6 * 1024 * 1024))).message).toMatch(/5 MB/);
      expect((await pgError(begin(s, w.a1, randomUUID(), "image/jpeg", 10, "not-a-hash"))).message).toMatch(/checksum/);
      await begin(s, w.a1);
      await begin(s, w.a1);
      expect((await pgError(begin(s, w.a1))).message).toMatch(/At most 3 photos/);

      await s.as(w.driver2);
      expect((await pgError(begin(s, w.a2, key))).code).toBe("42501"); // someone else's upload key
      const office = await s.createUser("office");
      await s.as(office);
      expect((await pgError(begin(s, w.a1))).code).toBe("42501"); // no driver portal
    });
  });

  it("storage accepts an object only at the caller's own reserved path", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const r = await begin(s, w.a1);
      const company = r.object_path.split("/")[0];
      expect((await pgError(putObject(s, `${company}/ticket-photos/${randomUUID()}.jpg`))).code).toBe("42501"); // invented path
      expect((await pgError(putObject(s, `${randomUUID()}/ticket-photos/${r.attachment_id}.jpg`))).code).toBe("42501"); // other company folder
      expect((await pgError(s.query("insert into storage.objects (bucket_id, name) values ('other-bucket', $1)", [r.object_path]))).code).toBe("42501");
      await s.as(w.driver2);
      expect((await pgError(putObject(s, r.object_path))).code).toBe("42501"); // another driver
      await s.as(null);
      expect((await pgError(putObject(s, r.object_path))).code).toBe("42501"); // signed out

      await s.as(w.driver1);
      expect((await pgError(confirm(s, r.attachment_id))).message).toMatch(/did not arrive/);
      await putObject(s, r.object_path, 999);
      expect((await pgError(confirm(s, r.attachment_id))).message).toMatch(/does not match/);
      await s.asAdmin();
      await s.query("update storage.objects set metadata = jsonb_build_object('size', 2048, 'mimetype', 'image/jpeg') where name = $1", [r.object_path]);
      await s.as(w.driver1);
      await confirm(s, r.attachment_id);
      expect((await pgError(putObject(s, r.object_path))).code).toBe("42501"); // no second object once uploaded
      expect(await canSee(s, r.object_path)).toBe(false); // drivers do not read objects back
      // No update or delete for app users.
      expect((await s.query("update storage.objects set metadata = '{}' where name = $1", [r.object_path])).rowCount).toBe(0);
    });
  });
});

describe.skipIf(!hasStorage)("photos with the ticket", () => {
  it("attaches confirmed photos in the ticket transaction, idempotently, and only the driver's own", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const p1 = await uploaded(s, w.a1);
      const p2 = await uploaded(s, w.a1);
      const pending = await begin(s, w.a1);

      // A photo still uploading blocks the ticket; nothing is created.
      const t0 = w.ticket({ photo_ids: [p1.attachment_id, pending.attachment_id] });
      expect((await pgError(submit(s, t0))).message).toMatch(/not ready/);
      expect((await pgError(submit(s, w.ticket({ photo_ids: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] })))).message).toMatch(/At most 3/);

      const payload = w.ticket({ photo_ids: [p1.attachment_id, p2.attachment_id] });
      const r = await submit(s, payload);
      expect(r).toMatchObject({ created: true, photos: 2 });
      expect(await submit(s, payload)).toMatchObject({ ticket_id: r.ticket_id, created: false, photos: 2 }); // retry

      await s.asAdmin();
      const rows = (await s.query<Row>("select status, ticket_id, ticket_number from public.ticket_attachments where id = any($1) order by id", [[p1.attachment_id, p2.attachment_id]])).rows;
      expect(rows.every((x) => x.status === "attached" && x.ticket_id === r.ticket_id && x.ticket_number === r.ticket_number)).toBe(true);
      expect((await s.query("select 1 from public.audit_events where action = 'ticket_photo.attached' and details ->> 'ticket_id' = $1", [r.ticket_id])).rowCount).toBe(1);
      expect((await s.query("select 1 from public.audit_events where action = 'ticket_photo.uploaded' and details ->> 'attachment_id' = $1", [p1.attachment_id])).rowCount).toBe(1);
      expect((await s.query("select status from public.delivery_tickets where id = $1", [r.ticket_id])).rows[0].status).toBe("submitted"); // never auto-accepted

      // Another driver cannot attach this driver's photo.
      await s.as(w.driver2);
      const other = await uploaded(s, w.a2);
      expect((await pgError(submit(s, { ...w.ticket({ assignment_id: w.a2 }), photo_ids: [pending.attachment_id] }))).message).toMatch(/not ready/);
      expect((await submit(s, { ...w.ticket({ assignment_id: w.a2 }), photo_ids: [other.attachment_id] })).photos).toBe(1);
    });
  });

  it("office reads attached photos of its company only; photos stay through corrections and voids", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const p = await uploaded(s, w.a1);
      const loose = await uploaded(s, w.a1); // uploaded, never attached
      const r = await submit(s, w.ticket({ photo_ids: [p.attachment_id] }));

      await s.as(w.office);
      expect(await canSee(s, p.object_path)).toBe(true);
      expect(await canSee(s, loose.object_path)).toBe(false);
      expect((await s.query("select id from public.ticket_attachments where ticket_number = $1", [r.ticket_number])).rows).toEqual([{ id: p.attachment_id }]);

      for (const role of ["mechanic", "driver"] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect(await canSee(s, p.object_path), role).toBe(false);
        expect((await s.query("select 1 from public.ticket_attachments")).rowCount, role).toBe(0);
      }
      await s.as(w.driver1);
      expect(await canSee(s, p.object_path)).toBe(false);
      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      expect(await canSee(s, p.object_path)).toBe(false);
      expect((await s.query("select 1 from public.ticket_attachments where id = $1", [p.attachment_id])).rowCount).toBe(0);

      // Correction: the photo stays with the ticket number (attached to revision 1).
      await s.as(w.office);
      const c = (await s.query<{ r: { ticket_id: string } }>("select public.correct_delivery_ticket($1, $2::jsonb, 'Re-read (test)') as r", [r.ticket_id, JSON.stringify({ load_id: (await loadOf(s, r.ticket_id)), order_line_id: w.order.materialLine, delivered_date: w.yesterday, delivered_time: "08:30", quantity: "21", unit_code: "ton", external_reference: "SC-CORR" })])).rows[0].r;
      expect((await s.query("select ticket_id from public.ticket_attachments where ticket_number = $1", [r.ticket_number])).rows).toEqual([{ ticket_id: r.ticket_id }]);
      await s.query("select public.review_delivery_ticket($1, 'void', 'Wrong load (test)')", [c.ticket_id]);
      expect(await canSee(s, p.object_path)).toBe(true); // kept as evidence after a void

      // Records resist changes.
      expect((await pgError(s.query("update public.ticket_attachments set status = 'discarded' where id = $1", [p.attachment_id]))).code).toBe("42501");
      await s.asAdmin();
      expect((await pgError(s.query("update public.ticket_attachments set status = 'discarded', discarded_at = now(), discard_reason = 'x', ticket_id = null where id = $1", [p.attachment_id]))).code).toBe("42501");
      expect((await pgError(s.query("update public.ticket_attachments set object_path = replace(object_path, '.jpg', '.png') where id = $1", [loose.attachment_id]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.ticket_attachments where id = $1", [p.attachment_id]))).code).toBe("42501");
    });
  });
});

async function loadOf(s: Session, ticketId: string) {
  return (await s.query<{ load_id: string }>("select load_id from public.delivery_tickets where id = $1", [ticketId])).rows[0].load_id;
}

describe.skipIf(!hasStorage)("abandoned uploads", () => {
  it("lists unattached uploads and orphan objects for the service role, and marks records only once the object is gone", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const fresh = await uploaded(s, w.a1);
      await s.asAdmin();
      const oldId = randomUUID();
      const oldPath = `00000000-0000-4000-8000-000000000001/ticket-photos/${oldId}.jpg`;
      await s.query(
        "insert into public.ticket_attachments (id, company_id, object_path, mime_type, size_bytes, sha256, upload_key, assignment_id, load_id, order_id, created_by, created_at) select $1, company_id, $2, 'image/jpeg', 10, $3, gen_random_uuid(), id, load_id, order_id, $4, now() - interval '2 days' from public.dispatch_assignments where id = $5",
        [oldId, oldPath, sha("old"), w.driver1, w.a1],
      );
      await s.query("insert into storage.objects (bucket_id, name, metadata) values ('ticket-photos', $1, '{}'), ('ticket-photos', $2, '{}')", [oldPath, `00000000-0000-4000-8000-000000000001/ticket-photos/${randomUUID()}.jpg`]);
      await s.query("set local role service_role");
      const listed = (await s.query<{ attachment_id: string | null; object_path: string; reason: string }>("select * from public.abandoned_ticket_photos(24)")).rows;
      expect(listed.find((x) => x.attachment_id === oldId)).toMatchObject({ object_path: oldPath });
      expect(listed.some((x) => x.attachment_id === null && x.reason === "no attachment record")).toBe(true);
      expect(listed.some((x) => x.attachment_id === fresh.attachment_id)).toBe(false);
      // Object still present: not marked.
      expect((await s.query<{ n: number }>("select public.mark_ticket_photos_discarded($1) as n", [[oldId]])).rows[0].n).toBe(0);
      await s.asAdmin();
      await s.query("select set_config('storage.allow_delete_query', 'true', true)");
      await s.query("delete from storage.objects where name = $1", [oldPath]);
      await s.query("set local role service_role");
      expect((await s.query<{ n: number }>("select public.mark_ticket_photos_discarded($1) as n", [[oldId]])).rows[0].n).toBe(1);
      await s.asAdmin();
      expect((await s.query("select status from public.ticket_attachments where id = $1", [oldId])).rows[0].status).toBe("discarded");

      await s.as(w.office);
      expect((await pgError(s.query("select * from public.abandoned_ticket_photos(24)"))).code).toBe("42501");
      expect((await pgError(s.query("select public.mark_ticket_photos_discarded($1)", [[oldId]]))).code).toBe("42501");
    });
  });
});
