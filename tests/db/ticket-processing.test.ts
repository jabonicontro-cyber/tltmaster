// Delivery ticket processing (N11): the company's paper-number requirement,
// office scans of paper tickets (reserve → upload under storage policy →
// attach, idempotent, audited, never across companies), and the verified
// delivery facts kept for future payroll. Synthetic data; rolled back.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const hasStorage = (await pool.query("select to_regclass('storage.objects') is not null as ok")).rows[0].ok as boolean;
if (!hasStorage) console.warn("Supabase Storage is not installed in this database: office scan tests are skipped. Start it with DEV_STORAGE=1 scripts/dev-stack/stack.sh up.");

type Row = Record<string, unknown>;
const submit = async (s: Session, payload: Row) =>
  (await s.query<{ r: { ticket_id: string; ticket_number: string; status: string } }>("select public.submit_delivery_ticket($1::jsonb) as r", [JSON.stringify(payload)])).rows[0].r;
const reasons = async (s: Session, id: string) => (await s.query<{ r: string[] }>("select review_reasons as r from public.delivery_tickets where id = $1", [id])).rows[0].r;
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const begin = async (s: Session, ticketId: string, key = randomUUID(), size = 2048) =>
  (await s.query<{ r: { attachment_id: string; object_path: string; status: string } }>("select public.begin_ticket_scan($1, $2, 'image/jpeg', $3, $4) as r", [ticketId, key, size, sha(key)])).rows[0].r;
/** What the storage server does on upload: insert the object row as the caller (storage policies apply). */
const store = (s: Session, path: string, size = 2048) =>
  s.query("insert into storage.objects (bucket_id, name, owner_id, metadata) values ('ticket-photos', $1, auth.uid()::text, $2::jsonb)", [path, JSON.stringify({ size, mimetype: "image/jpeg" })]);
const attach = async (s: Session, attachmentId: string, ticketId: string) =>
  (await s.query<{ r: { status: string; ticket_id: string } }>("select public.attach_ticket_scan($1, $2) as r", [attachmentId, ticketId])).rows[0].r;

/** An assigned load yesterday on a scheduled order (synthetic), entered by a fresh office user. */
async function world(s: Session) {
  const today = await businessToday(s);
  const yesterday = addDays(today, -1);
  const office = await s.createUser("office");
  const f = await fleet(s, office, yesterday);
  const order = await scheduledOrder(s, office, addDays(today, -2), addDays(today, 2), addDays(today, -2));
  const load = await planLoad(s, order.id, yesterday, "07:00", "09:00", { planned_quantity: "22", unit_code: "ton" });
  await assign(s, load.load_id, f.t1, null, f.d1);
  const payload = (extra: Row = {}) => ({ load_id: load.load_id, order_line_id: order.materialLine, delivered_date: yesterday, delivered_time: "08:30", quantity: "22", unit_code: "ton", external_reference: "", ...extra });
  return { today, yesterday, office, f, order, load, payload };
}

describe("company ticket requirements", () => {
  it("a missing paper ticket number is flagged only where the company requires one", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const t1 = await submit(s, w.payload());
      expect(await reasons(s, t1.ticket_id)).toContain("missing_external_reference");

      const owner = await s.createUser("owner");
      await s.as(owner);
      await s.query("update public.company_settings set ticket_reference_required = false");
      await s.as(w.office);
      const load2 = await planLoad(s, w.order.id, w.yesterday, "10:00", "11:00");
      await assign(s, load2.load_id, w.f.t2, null, w.f.d2);
      const t2 = await submit(s, w.payload({ load_id: load2.load_id, delivered_time: "10:30" }));
      expect(await reasons(s, t2.ticket_id)).not.toContain("missing_external_reference");
      expect(t2.status).toBe("submitted"); // received, still to be verified
      // Only settings.manage changes it (RLS filters anyone else's update).
      expect((await s.query("update public.company_settings set ticket_reference_required = true")).rowCount).toBe(0);
      // Another company keeps its own setting.
      const B = await s.createCompany("Mesa Rock Hauling (test)");
      await s.asAdmin();
      expect((await s.query("select ticket_reference_required from public.company_settings where company_id = $1", [B])).rows[0].ticket_reference_required).toBe(true);
    });
  });
});

describe.skipIf(!hasStorage)("office scans of paper tickets", () => {
  it("reserve, upload and attach once; recorded in the history; kept through corrections; only for live tickets", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const t = await submit(s, w.payload({ external_reference: `SC-${randomUUID().slice(0, 6)}` }));
      const key = randomUUID();
      const r = await begin(s, t.ticket_id, key);
      expect(r.status).toBe("pending");
      expect(r.object_path).toMatch(new RegExp(`^${TOP_LINE}/ticket-photos/`));
      expect(await begin(s, t.ticket_id, key)).toMatchObject({ attachment_id: r.attachment_id }); // retry: same reservation

      // Nothing stored yet: nothing is attached.
      expect((await pgError(attach(s, r.attachment_id, t.ticket_id))).message).toMatch(/did not arrive/);
      await store(s, r.object_path);
      expect(await attach(s, r.attachment_id, t.ticket_id)).toMatchObject({ status: "attached", ticket_id: t.ticket_id });
      expect(await attach(s, r.attachment_id, t.ticket_id)).toMatchObject({ status: "attached" }); // retry is safe
      const ev = await s.query<{ action: string; to_status: string }>("select action, to_status from public.delivery_ticket_events where ticket_id = $1 and action = 'photo_added'", [t.ticket_id]);
      expect(ev.rows).toEqual([{ action: "photo_added", to_status: "submitted" }]);
      // The original image cannot be replaced or deleted.
      expect((await pgError(s.query("update public.ticket_attachments set object_path = object_path where id = $1", [r.attachment_id]))).code).toBe("42501");
      await s.asAdmin();
      expect((await pgError(s.query("delete from public.ticket_attachments where id = $1", [r.attachment_id]))).code).toBe("42501");

      // A correction keeps the scan with the ticket number; scans go on the current revision only.
      await s.as(w.office);
      const c = (await s.query<{ r: { ticket_id: string } }>("select public.correct_delivery_ticket($1, $2::jsonb, 'Scale reissued') as r", [t.ticket_id, JSON.stringify(w.payload({ quantity: "21.5", external_reference: `SC-${randomUUID().slice(0, 6)}` }))])).rows[0].r;
      expect((await s.query("select 1 from public.ticket_attachments where ticket_number = $1 and status = 'attached'", [t.ticket_number])).rowCount).toBe(1);
      expect((await pgError(begin(s, t.ticket_id))).message).toMatch(/superseded/);
      expect((await begin(s, c.ticket_id)).status).toBe("pending");
    });
  });

  it("needs tickets.edit, refuses other companies' tickets and files, and never attaches across companies", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const t = await submit(s, w.payload({ external_reference: `SC-${randomUUID().slice(0, 6)}` }));
      const mechanic = await s.createUser("mechanic");
      await s.as(mechanic);
      expect((await pgError(begin(s, t.ticket_id))).code).toBe("42501");

      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOffice = await s.createUser("office", { companyId: B });
      await s.as(bOffice);
      expect((await pgError(begin(s, t.ticket_id))).code).toBe("P0002"); // by id from another company
      // B cannot upload into Top Line's folder, even with a guessed path.
      expect((await pgError(store(s, `${TOP_LINE}/ticket-photos/${randomUUID()}.jpg`))).code).toBe("42501");

      // Top Line's reservation cannot be attached by B, nor to B's tickets.
      await s.as(w.office);
      const r = await begin(s, t.ticket_id);
      await store(s, r.object_path);
      await s.as(bOffice);
      expect((await pgError(attach(s, r.attachment_id, t.ticket_id))).code).toBe("42501");
      expect((await s.query("select 1 from public.ticket_attachments")).rowCount).toBe(0);
      expect((await s.query("select 1 from storage.objects where bucket_id = 'ticket-photos' and name = $1", [r.object_path])).rowCount).toBe(0);
      await s.as(w.office);
      expect((await attach(s, r.attachment_id, t.ticket_id)).status).toBe("attached");
    });
  });
});

describe("verified delivery facts for future payroll", () => {
  it("list only verified current revisions with driver, truck, load and quantity — no money — per company and permission", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.office);
      const t = await submit(s, w.payload({ external_reference: `SC-${randomUUID().slice(0, 6)}` }));
      const facts = async () => (await s.query<Row>("select *, load_date::text as load_date from public.verified_delivery_inputs where load_id = $1", [w.load.load_id])).rows;
      expect(await facts()).toEqual([]); // received is not verified
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [t.ticket_id]);
      let f = await facts();
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ ticket_id: t.ticket_id, driver_id: w.f.d1, truck_id: w.f.t1, unit_code: "ton", load_date: w.yesterday });
      expect(Number(f[0].quantity)).toBe(22);
      expect(Object.keys(f[0]).some((k) => /cents|rate|amount|price|pay/.test(k))).toBe(false);

      // A correction replaces the fact only after the new revision is verified; the old one stays traceable.
      const c = (await s.query<{ r: { ticket_id: string } }>("select public.correct_delivery_ticket($1, $2::jsonb, 'Driver swap on paper') as r", [t.ticket_id, JSON.stringify(w.payload({ driver_id: w.f.d2, external_reference: `SC-${randomUUID().slice(0, 6)}` }))])).rows[0].r;
      expect(await facts()).toEqual([]);
      await s.query("select public.review_delivery_ticket($1, 'accept', '')", [c.ticket_id]);
      f = await facts();
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ ticket_id: c.ticket_id, supersedes_id: t.ticket_id, driver_id: w.f.d2, revision: 2 });
      // The dispatch assignment was not changed by the correction.
      expect((await s.query("select driver_id from public.dispatch_assignments where load_id = $1 and status = 'active'", [w.load.load_id])).rows[0].driver_id).toBe(w.f.d1);

      // Without tickets.view, or in another company: nothing.
      const mechanic = await s.createUser("mechanic");
      await s.as(mechanic);
      expect(await facts()).toEqual([]);
      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      expect((await s.query("select 1 from public.verified_delivery_inputs")).rowCount).toBe(0);
      // A company's own facts are its own.
      const bCustomer = await insert(s, "customers", { name: "Riverbend Builders (test)" });
      expect(bCustomer).toBeTruthy();
    });
  });
});
