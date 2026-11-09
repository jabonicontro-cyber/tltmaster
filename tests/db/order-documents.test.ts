// Order documents (MK2, 20261120009500): orders editors attach rate confirmations, bills of lading and proofs of
// delivery to an order, optionally to one of its stops; type, size, stop and count are checked; people who see orders
// can open them; removing keeps the record with a reason; drivers and other companies can neither add nor open them.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const begin = (s: Session, order: string, stop: string | null, kind: string, mime = "application/pdf", size = 1000, name = "Rate confirmation 4411.pdf") =>
  s.query<{ r: string }>("select public.order_document_begin($1, $2, $3, $4, $5, $6) r", [order, stop, kind, mime, size, name]);

describe("order documents", () => {
  it("attaches documents to an order and its stops, checks every limit, opens for viewers and removes with a reason", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const driver = await s.createUser("driver");
      const order = await scheduledOrder(s, office, today, addDays(today, 1), today);
      const other = await scheduledOrder(s, office, today, addDays(today, 1), today);
      await s.as(office);
      await s.query("select public.save_order_stops($1, $2::jsonb)", [order.id, JSON.stringify([
        { kind: "pickup", name: "Acme Steel (test)", city: "Gary", state: "IN" },
        { kind: "delivery", name: "Lakeside Build (test)", city: "Joliet", state: "IL" },
      ])]);
      await s.query("select public.save_order_stops($1, $2::jsonb)", [other.id, JSON.stringify([
        { kind: "pickup", name: "Other pickup (test)" }, { kind: "delivery", name: "Other delivery (test)" },
      ])]);
      const stops = (await s.query<{ id: string; kind: string }>("select id, kind from public.order_stops where order_id = $1 and removed_at is null order by seq", [order.id])).rows;
      const otherStop = (await s.query<{ id: string }>("select id from public.order_stops where order_id = $1 limit 1", [other.id])).rows[0].id;

      const path = (await begin(s, order.id, null, "rate_confirmation")).rows[0].r;
      expect(path).toMatch(/^[0-9a-f-]{36}\/orders\/[0-9a-f-]{36}\.pdf$/);
      const pod = (await begin(s, order.id, stops[1].id, "proof_of_delivery", "image/jpeg", 2_000, "pod/../photo.jpg")).rows[0].r;
      expect(pod).toMatch(/\.jpg$/);
      const docs = (await s.query<{ id: string; kind: string; stop_id: string | null; file_name: string }>("select id, kind, stop_id, file_name from public.order_documents where order_id = $1 order by kind desc", [order.id])).rows;
      expect(docs.map((d) => [d.kind, d.stop_id])).toEqual([["rate_confirmation", null], ["proof_of_delivery", stops[1].id]]);
      expect(docs[1].file_name).not.toContain("/"); // path separators never reach the stored name

      // Refused: another order's stop, an unknown kind, a wrong type, too large.
      expect((await pgError(begin(s, order.id, otherStop, "proof_of_delivery"))).message).toMatch(/not on this order/);
      expect((await pgError(begin(s, order.id, null, "invoice"))).message).toMatch(/what the document is/);
      expect((await pgError(begin(s, order.id, null, "other", "application/zip"))).message).toMatch(/photos .* or PDFs/);
      expect((await pgError(begin(s, order.id, null, "other", "application/pdf", 10_485_761))).message).toMatch(/10 MB/);

      // Opening: anyone who sees orders; the path only, through the function.
      await s.as(dispatcher);
      expect((await s.query<{ r: { path: string } }>("select public.order_document_path($1) r", [docs[0].id])).rows[0].r.path).toBe(path);
      expect((await pgError(begin(s, order.id, null, "other"))).code).toBe("42501"); // dispatchers do not edit orders

      // Removing keeps the record and a reason; the file can no longer be opened.
      await s.as(office);
      expect((await pgError(s.query("select public.order_document_remove($1, ' ')", [docs[0].id]))).message).toMatch(/reason/);
      await s.query("select public.order_document_remove($1, 'Wrong load (test)')", [docs[0].id]);
      expect((await s.query<{ r: unknown }>("select public.order_document_path($1) r", [docs[0].id])).rows[0].r).toBeNull();
      expect((await s.query("select 1 from public.order_documents where id = $1 and removed_at is not null and remove_reason = 'Wrong load (test)'", [docs[0].id])).rowCount).toBe(1);
      const events = (await s.query<{ action: string }>("select action from public.audit_events where entity_id = $1 and action like 'order.document%'", [order.id])).rows.map((r) => r.action).sort();
      expect(events).toEqual(["order.document_added", "order.document_added", "order.document_removed"]);

      // Drivers and another company: nothing.
      await s.as(driver);
      expect((await pgError(begin(s, order.id, null, "other"))).code).toBe("42501");
      expect((await s.query<{ r: unknown }>("select public.order_document_path($1) r", [docs[1].id])).rows[0].r).toBeNull();
      const elsewhere = await s.createCompany("Elsewhere Freight");
      const stranger = await s.createUser("owner", { companyId: elsewhere });
      await s.as(stranger);
      expect((await s.query("select 1 from public.order_documents")).rowCount).toBe(0);
      expect((await pgError(begin(s, order.id, null, "other"))).message).toMatch(/Order not found/);
      expect((await s.query<{ r: unknown }>("select public.order_document_path($1) r", [docs[1].id])).rows[0].r).toBeNull();
    });
  });
});
