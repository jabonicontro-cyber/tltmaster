// Proof of delivery from the driver's phone (MK2, 20261120020800): the assigned driver adds a proof of delivery to a
// delivery stop of their OWN active load (from two days ago to today), idempotently per upload key, with type, size and
// count limits; the kind is always proof of delivery. Another driver, an office user without driver access and another
// company are refused; a driver still cannot open order documents or read the list. The office sees the document with
// its load; the driver lists only their own. The rollback is applied and exercised inside the test transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const migration = readFileSync(join(__dirname, "../../supabase/migrations/20261120020800_driver_proof_of_delivery.sql"), "utf8");
const rollback = readFileSync(join(__dirname, "../../supabase/rollbacks/20261120020800_driver_proof_of_delivery.down.sql"), "utf8")
  .replace(/^\s*begin;\s*$/m, "").replace(/^\s*commit;\s*$/m, "");

type Begin = { document_id: string; path: string; existing: boolean };
const begin = async (s: Session, assignment: string, stop: string, key: string = randomUUID(), mime = "image/jpeg", size = 2048, name = "pod.jpg") =>
  (await s.query<{ r: Begin }>("select public.driver_pod_begin($1, $2, $3, $4, $5, $6) r", [assignment, stop, key, mime, size, name])).rows[0].r;
const proofs = async (s: Session) => (await s.query<{ r: Record<string, Record<string, Array<{ id: string; name: string }>>> }>("select public.driver_stop_proofs() r")).rows[0].r;

async function world(s: Session) {
  // Installed on the local database already; applied again inside the transaction (idempotent) so the test runs anywhere.
  await s.asAdmin();
  await s.query(migration);
  const today = await businessToday(s);
  const office = await s.createUser("office");
  const f = await fleet(s, office, addDays(today, -3));
  const order = await scheduledOrder(s, office, addDays(today, -3), addDays(today, 2), addDays(today, -3));
  await s.query("select public.save_order_stops($1, $2::jsonb)", [order.id, JSON.stringify([
    { kind: "pickup", name: "Acme Steel (test)", city: "Gary", state: "IN" },
    { kind: "delivery", name: "Lakeside Build (test)", city: "Joliet", state: "IL" },
    { kind: "delivery", name: "Harbor Supply (test)", city: "Hammond", state: "IN" },
  ])]);
  const stops = (await s.query<{ id: string; kind: string }>("select id, kind from public.order_stops where order_id = $1 and removed_at is null order by seq", [order.id])).rows;
  const other = await scheduledOrder(s, office, today, addDays(today, 1), today);
  await s.query("select public.save_order_stops($1, $2::jsonb)", [other.id, JSON.stringify([{ kind: "pickup", name: "Other pickup (test)" }, { kind: "delivery", name: "Other delivery (test)" }])]);
  const otherStop = (await s.query<{ id: string }>("select id from public.order_stops where order_id = $1 and kind = 'delivery'", [other.id])).rows[0].id;
  const mine = await planLoad(s, order.id, today, "06:00", "07:00");
  const a1 = await assign(s, mine.load_id, f.t1, null, f.d1);
  const theirs = await planLoad(s, order.id, today, "08:00", "09:00");
  const a2 = await assign(s, theirs.load_id, f.t2, null, f.d2);
  const old = await planLoad(s, order.id, addDays(today, -3), "06:00", "07:00");
  const aOld = await assign(s, old.load_id, f.t1, null, f.d1);
  const later = await planLoad(s, order.id, addDays(today, 1), "06:00", "07:00");
  const aLater = await assign(s, later.load_id, f.t1, null, f.d1);
  const driver1 = await s.createUser("driver");
  const driver2 = await s.createUser("driver");
  await s.as(office);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driver1]);
  await s.query("update public.drivers set user_id = $2 where id = $1", [f.d2, driver2]);
  return { today, office, order, stops, pickup: stops[0].id, drop1: stops[1].id, drop2: stops[2].id, otherStop, mine, a1, a2, aOld, aLater, driver1, driver2 };
}

describe("proof of delivery from the driver's phone", () => {
  it("lets the assigned driver add proof of delivery at a delivery stop of their own load, idempotently, within the limits", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      const key = randomUUID();
      const r = await begin(s, w.a1, w.drop1, key, "image/jpeg", 2048, "pod/../photo.jpg");
      expect(r.existing).toBe(false);
      expect(r.path).toMatch(/^00000000-0000-4000-8000-000000000001\/orders\/[0-9a-f-]{36}\.jpg$/);
      // A retry with the same key: the same record, never a second one.
      expect(await begin(s, w.a1, w.drop1, key)).toEqual({ ...r, existing: true });
      const pdf = await begin(s, w.a1, w.drop2, randomUUID(), "application/pdf", 5000, "signed-receipt.pdf");
      expect(pdf.path).toMatch(/\.pdf$/);

      // Refused: the pickup, another order's stop, another driver's load, a load three days ago or tomorrow, a wrong
      // type, too large, and no upload key.
      expect((await pgError(begin(s, w.a1, w.pickup))).message).toMatch(/at a delivery stop/);
      expect((await pgError(begin(s, w.a1, w.otherStop))).message).toMatch(/not on this load/);
      expect((await pgError(begin(s, w.a2, w.drop1))).code).toBe("42501");
      expect((await pgError(begin(s, w.aOld, w.drop1))).message).toMatch(/two days ago to today/);
      expect((await pgError(begin(s, w.aLater, w.drop1))).message).toMatch(/two days ago to today/);
      expect((await pgError(begin(s, w.a1, w.drop1, randomUUID(), "application/zip"))).message).toMatch(/photo .* or a PDF/);
      expect((await pgError(begin(s, w.a1, w.drop1, randomUUID(), "image/jpeg", 4_194_305))).message).toMatch(/4 MB/);
      expect((await pgError(s.query("select public.driver_pod_begin($1, $2, null, 'image/jpeg', 10, 'x')", [w.a1, w.drop1]))).message).toMatch(/upload key/);
      // At most 5 per stop and load.
      for (let i = 0; i < 4; i++) await begin(s, w.a1, w.drop1);
      expect((await pgError(begin(s, w.a1, w.drop1))).message).toMatch(/already has 5/);

      // The driver lists only their own, per load and stop, without paths; they still cannot read the table or open a file.
      const mine = await proofs(s);
      expect(Object.keys(mine)).toEqual([w.mine.load_id]);
      expect(mine[w.mine.load_id][w.drop1]).toHaveLength(5);
      expect(mine[w.mine.load_id][w.drop1][0].name).toBe("pod..photo.jpg");
      expect(JSON.stringify(mine)).not.toContain("/orders/");
      expect((await s.query("select 1 from public.order_documents")).rowCount).toBe(0);
      expect((await s.query<{ r: unknown }>("select public.order_document_path($1) r", [r.document_id])).rows[0].r).toBeNull();
      // And they still cannot add any other document the office way.
      expect((await pgError(s.query("select public.order_document_begin($1, null, 'rate_confirmation', 'application/pdf', 10, 'x.pdf')", [w.order.id]))).code).toBe("42501");

      // The office sees it with its stop, load, kind and who added it; the history names the driver's load and stop.
      await s.as(w.office);
      const doc = (await s.query<{ kind: string; stop_id: string; load_id: string; uploaded_by: string }>("select kind, stop_id, load_id, uploaded_by from public.order_documents where id = $1", [r.document_id])).rows[0];
      expect(doc).toEqual({ kind: "proof_of_delivery", stop_id: w.drop1, load_id: w.mine.load_id, uploaded_by: w.driver1 });
      expect((await s.query<{ r: { path: string } }>("select public.order_document_path($1) r", [r.document_id])).rows[0].r.path).toBe(r.path);
      const summary = (await s.query<{ summary: string }>("select summary from public.audit_events where entity_id = $1 and action = 'order.document_added' and details ->> 'document_id' = $2", [w.order.id, r.document_id])).rows[0].summary;
      expect(summary).toMatch(/Proof of delivery added by Test driver for load \d+ at stop 2 \(Lakeside Build \(test\)\)/);
      // Removed by the office with a reason: gone from the driver's list.
      await s.query("select public.order_document_remove($1, 'Wrong stop (test)')", [r.document_id]);
      await s.as(w.driver1);
      expect((await proofs(s))[w.mine.load_id][w.drop1]).toHaveLength(4);
      // The same upload key now refers to a removed record: a new photo is needed.
      expect((await pgError(begin(s, w.a1, w.drop1, key))).message).toMatch(/Take it again/);
    });
  });

  it("refuses another driver, someone without driver access, a canceled load and another company", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver2);
      expect((await pgError(begin(s, w.a1, w.drop1))).code).toBe("42501");
      expect(await proofs(s)).toEqual({});
      const key = randomUUID();
      await s.as(w.driver1);
      await begin(s, w.a1, w.drop1, key);
      // Someone else reusing the driver's upload key gets nothing.
      await s.as(w.driver2);
      expect((await pgError(begin(s, w.a2, w.drop1, key))).message).toMatch(/already used/);
      // The office has no driver record: refused (driver access is the driver's own).
      await s.as(w.office);
      expect((await pgError(begin(s, w.a1, w.drop1))).code).toBe("42501");
      // A canceled load is refused (its assignment is released with it).
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      await s.query("select public.cancel_order_load($1, 'Customer canceled (test)')", [w.mine.load_id]);
      await s.as(w.driver1);
      expect((await pgError(begin(s, w.a1, w.drop1))).code).toBe("42501");
      // Another company's owner sees nothing and cannot add.
      const elsewhere = await s.createCompany("Elsewhere Freight (test)");
      const stranger = await s.createUser("owner", { companyId: elsewhere });
      await s.as(stranger);
      expect((await s.query("select 1 from public.order_documents")).rowCount).toBe(0);
      expect((await pgError(begin(s, w.a2, w.drop1))).code).toBe("42501");
    });
  });

  it("the rollback removes the driver functions and keeps the office's documents", async () => {
    await withSession(async (s) => {
      const w = await world(s);
      await s.as(w.driver1);
      await begin(s, w.a1, w.drop1);
      await s.as(w.office);
      await s.query("select public.order_document_begin($1, null, 'rate_confirmation', 'application/pdf', 10, 'rate.pdf')", [w.order.id]);
      await s.asAdmin();
      await s.query(rollback);
      expect((await s.query("select 1 from pg_proc where proname in ('driver_pod_begin', 'driver_stop_proofs')")).rowCount).toBe(0);
      expect((await s.query("select 1 from information_schema.columns where table_name = 'order_documents' and column_name in ('load_id', 'upload_key')")).rowCount).toBe(0);
      await s.as(w.office);
      expect((await s.query<{ kind: string }>("select kind from public.order_documents where order_id = $1 order by kind", [w.order.id])).rows.map((r) => r.kind)).toEqual(["proof_of_delivery", "rate_confirmation"]);
    });
  });
});
