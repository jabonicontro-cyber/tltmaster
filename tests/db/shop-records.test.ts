// Shop records (2026-11-09): the annual inspection updates the unit's inspection certificate (20261120012400); outside
// repairs record the vendor's invoice and warranty (20261120012500); a part used on a job can go back to stock with an
// audit trail, and its cost comes off the job (20261120012600).
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { businessToday, insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);
const createWo = (s: Session, p: Record<string, unknown>) =>
  s.query<{ r: { id: string; number: string } }>("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify(p)]).then((r) => r.rows[0].r);
const status = (s: Session, id: string, to: string) => s.query("select public.maintenance_set_status($1, $2, '')", [id, to]);

describe("annual inspection", () => {
  it("updates the inspection certificate from a completed inspection work order, keeping the old one archived", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `AI-${tag()}`, truck_type: "tri_axle_dump" });
      const old = await insert(s, "vehicle_documents", { truck_id: t, kind: "inspection", issued_on: addDays(today, -360), expires_on: addDays(today, 5) });
      await s.as(mechanic);
      const wo = await createWo(s, { truck_id: t, title: "Annual DOT inspection", category: "inspection" });
      const record = (p: Record<string, unknown>, id = wo.id) => s.query<{ id: string }>("select public.maintenance_record_inspection($1, $2::jsonb) id", [id, JSON.stringify(p)]);
      const good = { inspected_on: today, expires_on: addDays(today, 365), inspector: "Pat Inspector", reference: "STK-4411" };
      expect((await pgError(record(good))).message).toMatch(/Complete the inspection work order first/);
      await status(s, wo.id, "in_progress");
      await status(s, wo.id, "completed");
      expect((await pgError(record({ ...good, inspector: "" }))).message).toMatch(/who did the inspection/);
      expect((await pgError(record({ ...good, expires_on: today }))).message).toMatch(/after the inspection day/);
      expect((await pgError(record({ ...good, inspected_on: addDays(today, 1) }))).message).toMatch(/not in the future/);
      const doc = (await record(good)).rows[0].id;
      // Recording again from the same work order corrects its own certificate; nothing is duplicated.
      expect((await record({ ...good, reference: "STK-4412" })).rows[0].id).toBe(doc);

      await s.as(owner);
      const docs = await s.query<{ id: string; archived: boolean; expires_on: string; issuing_authority: string; reference_number: string; verified_at: string | null }>(
        "select id, archived_at is not null as archived, expires_on::text, issuing_authority, reference_number, verified_at from public.vehicle_documents where truck_id = $1 order by created_at", [t]);
      expect(docs.rows).toEqual([
        expect.objectContaining({ id: old, archived: true }),
        { id: doc, archived: false, expires_on: addDays(today, 365), issuing_authority: "Pat Inspector", reference_number: "STK-4412", verified_at: null },
      ]);

      // Only inspection work orders; other companies cannot record on it.
      await s.as(mechanic);
      const repair = await createWo(s, { truck_id: t, title: "Wiper motor", category: "electrical" });
      await status(s, repair.id, "in_progress");
      await status(s, repair.id, "completed");
      expect((await pgError(record(good, repair.id))).message).toMatch(/Only an inspection work order/);
      const driver = await s.createUser("driver");
      await s.as(driver);
      expect((await pgError(record(good))).code).toBe("42501");
      const other = await s.createCompany(`Other ${tag()}`);
      await s.as(await s.createUser("owner", { companyId: other }));
      expect((await pgError(record(good))).code).toBe("P0002");
    });
  });
});

describe("outside repairs", () => {
  it("record the vendor invoice number, date and warranty on vendor lines only", async () => {
    await withSession(async (s) => {
      const today = await businessToday(s);
      const owner = await s.createUser("owner");
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `OR-${tag()}`, truck_type: "tri_axle_dump" });
      const wo = await createWo(s, { truck_id: t, title: "Transmission rebuild at the dealer" });
      const line = (kind: string, extra: Record<string, unknown>) => s.query(
        "insert into public.work_order_costs (work_order_id, kind, description, vendor_name, unit_cost_cents, invoice_number, invoice_date, warranty_until) values ($1, $2, 'Rebuild', 'Dealer', 450000, $3, $4, $5)",
        [wo.id, kind, extra.invoice_number ?? "", extra.invoice_date ?? null, extra.warranty_until ?? null]);
      await line("vendor", { invoice_number: "INV-889", invoice_date: today, warranty_until: addDays(today, 180) });
      expect((await pgError(line("part", { invoice_number: "INV-1" }))).code).toBe("23514");
      expect((await pgError(line("vendor", { invoice_date: today, warranty_until: addDays(today, -1) }))).code).toBe("23514");
      const w = await s.query<{ work_order_number: string; invoice_number: string; warranty_until: string }>("select work_order_number, invoice_number, warranty_until::text from public.vendor_warranties() where truck_id = $1", [t]);
      expect(w.rows).toEqual([{ work_order_number: wo.number, invoice_number: "INV-889", warranty_until: addDays(today, 180) }]);
      // A mechanic sees the warranty (no amounts) but cannot write cost lines.
      const mechanic = await s.createUser("mechanic");
      await s.as(mechanic);
      expect((await s.query("select 1 from public.vendor_warranties() where truck_id = $1", [t])).rowCount).toBe(1);
      expect((await pgError(line("vendor", {}))).code).toBe("42501");
    });
  });
});

describe("return a part to stock", () => {
  it("reverses the use with an audit trail, credits the cost and never returns more than was used", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `RS-${tag()}`, truck_type: "tri_axle_dump" });
      const part = (await s.query<{ id: string }>("select public.part_save(null, $1::jsonb) id", [JSON.stringify({ name: "Oil filter", part_number: `OF-${tag()}` })])).rows[0].id;
      await s.query("select public.part_receive($1, 5, 1895, 'Opening stock')", [part]);
      await s.as(mechanic);
      const wo = await createWo(s, { truck_id: t, title: "Oil service" });
      await s.query("select public.part_use($1, $2, 3)", [part, wo.id]);
      const use = (await s.query<{ id: string }>("select id from public.part_movements where part_id = $1 and kind = 'used'", [part])).rows[0].id;
      const ret = (q: number, reason = "Not needed, unopened") => s.query("select public.part_return($1, $2, $3)", [use, q, reason]);

      expect((await pgError(ret(1, ""))).message).toMatch(/why/);
      expect((await pgError(ret(4))).message).toMatch(/Only 3 each/);
      await ret(2);
      expect((await pgError(ret(2))).message).toMatch(/Only 1 each/);
      const onHand = (await s.query<{ on_hand: string }>("select on_hand::text from public.parts where id = $1", [part])).rows[0].on_hand;
      expect(onHand).toBe("4.00");
      const moves = await s.query<{ kind: string; quantity: string; returned_from: string | null; note: string }>(
        "select kind, quantity::text, returned_from::text, note from public.part_movements where part_id = $1 order by id", [part]);
      expect(moves.rows.map((m) => [m.kind, m.quantity])).toEqual([["received", "5.00"], ["used", "-3.00"], ["returned", "2.00"]]);
      expect(moves.rows[2]).toMatchObject({ returned_from: use, note: "Not needed, unopened" });
      const history = await s.query<{ note: string }>("select note from public.work_order_events where work_order_id = $1 and note like 'Returned to stock%'", [wo.id]);
      expect(history.rows[0].note).toBe("Returned to stock: 2 each Oil filter (Not needed, unopened)");

      // The cost comes off the job: 3 used at $18.95, 2 credited.
      await s.as(owner);
      const costs = await s.query<{ id: string; quantity: string; unit_cost_cents: string }>("select id, quantity::text, unit_cost_cents::text from public.work_order_costs where work_order_id = $1 order by quantity desc", [wo.id]);
      expect(costs.rows.map((c) => [c.quantity, c.unit_cost_cents])).toEqual([["3.00", "1895"], ["-2.00", "1895"]]);
      // The credit line cannot be removed by hand, and nobody can write a negative line directly.
      await s.query("delete from public.work_order_costs where id = $1", [costs.rows[1].id]);
      expect((await s.query("select 1 from public.work_order_costs where id = $1", [costs.rows[1].id])).rowCount).toBe(1);
      expect((await pgError(s.query("insert into public.work_order_costs (work_order_id, kind, description, quantity, unit_cost_cents) values ($1, 'part', 'Sneaky credit', -1, 100)", [wo.id]))).code).toBe("23514");

      // Dispatchers and other companies cannot return parts.
      await s.as(await s.createUser("dispatcher"));
      expect((await pgError(ret(1))).code).toBe("42501");
      const other = await s.createCompany(`Other ${tag()}`);
      await s.as(await s.createUser("owner", { companyId: other }));
      expect((await pgError(ret(1))).code).toBe("P0002");
    });
  });
});
