// Parts on order (20261120012300): a job may wait for parts before work starts; each part on order records the part,
// vendor, PO number, expected date and (for cost people) the cost; receiving goes through the parts ledger or a cost
// line, never a second record of stock or cost, and can put the job back in the queue.
import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);

async function setup(s: Session) {
  const owner = await s.createUser("owner");
  const mechanic = await s.createUser("mechanic");
  await s.as(owner);
  const truck = await insert(s, "trucks", { unit_number: `PW-${tag()}`, truck_type: "tri_axle_dump" });
  await s.as(mechanic);
  const wo = (await s.query<{ r: { id: string; number: string } }>("select public.maintenance_create_work_order($1::jsonb) r",
    [JSON.stringify({ truck_id: truck, title: "DEF sensor reading low" })])).rows[0].r;
  return { owner, mechanic, truck, wo };
}
const add = (s: Session, wo: string, p: Record<string, unknown>) =>
  s.query<{ id: string }>("select public.part_wait_add($1, $2::jsonb) id", [wo, JSON.stringify(p)]).then((r) => r.rows[0].id);
const waits = (s: Session, wo: string | null) =>
  s.query<{ id: string; description: string; status: string; unit_cost_cents: string | null; po_number: string; expected_on: string | null; work_order_number: string }>(
    "select id, description, status, unit_cost_cents::text, po_number, expected_on::text, work_order_number from public.part_waits($1)", [wo]).then((r) => r.rows);
const woStatus = async (s: Session, id: string) => (await s.query<{ status: string }>("select status from public.work_orders where id = $1", [id])).rows[0].status;

describe("parts on order", () => {
  it("waits for a part before work starts, records it, receives it as a cost line and returns the job to the queue", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      // Before work starts: reported -> waiting for parts.
      const key = crypto.randomUUID();
      const id = await add(s, w.wo.id, { description: "DEF level sensor", vendor_name: "Parts Co", po_number: "PO-77", expected_on: "2026-11-20", unit_cost_cents: 18650, set_waiting: true, submission_key: key });
      expect(await add(s, w.wo.id, { description: "DEF level sensor", submission_key: key })).toBe(id); // a double submit adds nothing
      expect(await woStatus(s, w.wo.id)).toBe("awaiting_parts");
      const note = await s.query<{ note: string }>("select note from public.work_order_events where work_order_id = $1 and kind = 'status' and to_status = 'awaiting_parts'", [w.wo.id]);
      expect(note.rows[0].note).toBe("DEF level sensor");

      // A mechanic does not see costs; the cost was not kept from someone without cost access.
      expect((await waits(s, w.wo.id))[0]).toMatchObject({ description: "DEF level sensor", status: "waiting", unit_cost_cents: null, po_number: "PO-77", expected_on: "2026-11-20" });
      expect((await waits(s, null)).map((x) => x.id)).toContain(id);

      // The owner (costs) records the price on a second part, then both arrive.
      await s.as(w.owner);
      const clip = await add(s, w.wo.id, { description: "Harness clip", quantity: 2, unit_cost_cents: 425 });
      expect((await waits(s, w.wo.id)).find((x) => x.id === clip)?.unit_cost_cents).toBe("425");
      await s.query("select public.part_wait_update($1, $2::jsonb)", [id, JSON.stringify({ expected_on: "2026-11-22" })]);
      const first = (await s.query<{ r: { waiting: number; status: string } }>("select public.part_wait_receive($1, true) r", [clip])).rows[0].r;
      expect(first).toMatchObject({ waiting: 1, status: "awaiting_parts" }); // one part still waiting: the job waits
      const second = (await s.query<{ r: { waiting: number; status: string } }>("select public.part_wait_receive($1, true) r", [id])).rows[0].r;
      expect(second).toMatchObject({ waiting: 0, status: "triaged" });
      expect(await woStatus(s, w.wo.id)).toBe("triaged");
      // Only the clip had a known cost: one cost line, nothing invented for the sensor.
      const costs = await s.query<{ description: string; quantity: string; unit_cost_cents: string; vendor_name: string }>(
        "select description, quantity::text, unit_cost_cents::text, vendor_name from public.work_order_costs where work_order_id = $1", [w.wo.id]);
      expect(costs.rows).toEqual([{ description: "Harness clip", quantity: "2.00", unit_cost_cents: "425", vendor_name: "" }]);
      expect((await pgError(s.query("select public.part_wait_receive($1, false)", [id]))).message).toMatch(/already received/);
      expect(await waits(s, null)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    });
  });

  it("a stock part goes through the parts ledger; cancel needs a reason; other people and companies cannot change it", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      const part = (await s.query<{ id: string }>("select public.part_save(null, $1::jsonb) id", [JSON.stringify({ name: "Brake chamber", part_number: `BC-${tag()}` })])).rows[0].id;
      await s.as(w.mechanic);
      await s.query("select public.maintenance_set_status($1, 'in_progress', '')", [w.wo.id]);
      const id = await add(s, w.wo.id, { part_id: part, vendor_name: "Brake Supply", unit_cost_cents: 9900, set_waiting: true });
      expect((await waits(s, w.wo.id))[0].description).toBe("Brake chamber");
      await s.as(w.owner);
      await s.query("select public.part_wait_update($1, $2::jsonb)", [id, JSON.stringify({ po_number: "PO-9" })]);
      await s.query("select public.part_wait_receive($1, false)", [id]);
      expect(await woStatus(s, w.wo.id)).toBe("awaiting_parts"); // not sent back to the queue when not asked
      const moves = await s.query<{ kind: string; quantity: string; work_order_id: string | null }>(
        "select kind, quantity::text, work_order_id from public.part_movements where part_id = $1 order by id", [part]);
      expect(moves.rows).toEqual([{ kind: "received", quantity: "1.00", work_order_id: null }, { kind: "used", quantity: "-1.00", work_order_id: w.wo.id }]);
      expect((await s.query<{ on_hand: string }>("select on_hand::text from public.parts where id = $1", [part])).rows[0].on_hand).toBe("0.00");
      // The mechanic's cost was not kept, so the ledger's latest known cost (none) applies: no cost line is invented.
      expect((await s.query("select 1 from public.work_order_costs where work_order_id = $1", [w.wo.id])).rowCount).toBe(0);

      const other = await add(s, w.wo.id, { description: "Spare hose" });
      expect((await pgError(s.query("select public.part_wait_cancel($1, '')", [other]))).message).toMatch(/why/);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.part_wait_cancel($1, 'Not needed')", [other]))).code).toBe("42501");
      expect((await pgError(add(s, w.wo.id, { description: "Anything" }))).code).toBe("42501");
      expect((await waits(s, w.wo.id)).length).toBe(2); // dispatchers read (maintenance.view)
      expect((await pgError(s.query("select unit_cost_cents from public.work_order_part_waits where id = $1", [other]))).code).toBe("42501");

      const otherCo = await s.createCompany(`Other ${tag()}`);
      const outsider = await s.createUser("owner", { companyId: otherCo });
      await s.as(outsider);
      expect(await waits(s, w.wo.id)).toEqual([]);
      expect((await s.query("select 1 from public.work_order_part_waits where id = $1", [other])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.part_wait_cancel($1, 'Not needed')", [other]))).code).toBe("P0002");
      await s.as(w.owner);
      await s.query("select public.part_wait_cancel($1, 'Found one on the shelf')", [other]);
      expect((await waits(s, w.wo.id)).find((x) => x.id === other)?.status).toBe("canceled");
    });
  });

  it("jobs may wait for parts before work starts and go back to the queue (lifecycle)", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.query("select public.maintenance_set_status($1, 'awaiting_parts', 'Mirror glass')", [w.wo.id]);
      await s.query("select public.maintenance_set_status($1, 'triaged', '')", [w.wo.id]);
      await s.query("select public.maintenance_set_status($1, 'awaiting_parts', 'Mirror glass')", [w.wo.id]);
      expect(await woStatus(s, w.wo.id)).toBe("awaiting_parts");
    });
  });
});
