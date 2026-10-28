// Shop parts inventory (B105, migration 20261120004500): parts are added and received by maintenance.manage, used on
// open work orders without going below zero, with a cost line only when a cost is known; unit costs are readable only
// with maintenance.costs; other companies see nothing.
import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 6);

describe("parts inventory", () => {
  it("receives, counts and uses parts on a work order", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const mechanic = await s.createUser("mechanic");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(owner);
      const truck = await insert(s, "trucks", { unit_number: `P-${tag()}`, truck_type: "tri_axle_dump" });
      const wo = (await s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) r",
        [JSON.stringify({ truck_id: truck, title: "Replace brake shoes", category: "brakes" })])).rows[0].r.id;
      const number = `BS-${tag()}`;

      // The owner adds a part and receives 4 at $128.00; the number is unique per company.
      const part = (await s.query<{ r: string }>("select public.part_save(null, $1::jsonb) r", [JSON.stringify({ part_number: number, name: "Brake shoe kit", unit: "kit", reorder_point: 2 })])).rows[0].r;
      expect((await pgError(s.query("select public.part_save(null, $1::jsonb)", [JSON.stringify({ part_number: number.toLowerCase(), name: "Duplicate" })]))).message).toMatch(/already has this part number/);
      expect(Number((await s.query<{ r: string }>("select public.part_receive($1, 4, 12800, 'PO 77') r", [part])).rows[0].r)).toBe(4);

      // A mechanic uses 3; a fourth time 2 would go below zero and is refused.
      await s.as(mechanic);
      const used = (await s.query<{ r: { on_hand: number; cost_added: boolean } }>("select public.part_use($1, $2, 3) r", [part, wo])).rows[0].r;
      expect(used).toEqual({ on_hand: 1, cost_added: true });
      expect((await pgError(s.query("select public.part_use($1, $2, 2)", [part, wo]))).message).toMatch(/Only 1 kit on hand/);
      // The mechanic receives without seeing costs: the cost they send is not kept.
      await s.query("select public.part_receive($1, 1, 99999, '')", [part]);
      expect((await pgError(s.query("select unit_cost_cents from public.part_movements where part_id = $1", [part]))).message).toMatch(/permission denied/);
      expect((await s.query("select * from public.part_costs()")).rowCount).toBe(0);
      // A count needs a reason.
      expect((await pgError(s.query("select public.part_count($1, 5, ' ')", [part]))).message).toMatch(/reason/);
      await s.query("select public.part_count($1, 5, 'Found a box')", [part]);

      // The owner sees the cost line on the work order, the latest known cost and the movements.
      await s.as(owner);
      const cost = (await s.query<{ kind: string; quantity: string; unit_cost_cents: string; part_number: string }>("select kind, quantity, unit_cost_cents, part_number from public.work_order_costs where work_order_id = $1", [wo])).rows;
      expect(cost).toEqual([{ kind: "part", quantity: "3.00", unit_cost_cents: "12800", part_number: number }]);
      const pc = (await s.query<{ unit_cost_cents: string; stock_value_cents: string }>("select unit_cost_cents, stock_value_cents from public.part_costs() where part_id = $1", [part])).rows[0];
      expect(pc).toEqual({ unit_cost_cents: "12800", stock_value_cents: "64000" });
      const kinds = (await s.query<{ kind: string; quantity: string }>("select kind, quantity from public.part_movements where part_id = $1 order by id", [part])).rows;
      expect(kinds).toEqual([{ kind: "received", quantity: "4.00" }, { kind: "used", quantity: "-3.00" }, { kind: "received", quantity: "1.00" }, { kind: "adjusted", quantity: "3.00" }]);

      // Dispatch sees parts but cannot change stock.
      await s.as(dispatcher);
      expect((await s.query("select id from public.parts where id = $1", [part])).rowCount).toBe(1);
      expect((await pgError(s.query("select public.part_receive($1, 1, null, '')", [part]))).message).toMatch(/permission/);

      // Another company sees nothing.
      const other = await s.createCompany("Other Parts Co (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.parts where id = $1", [part])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.part_use($1, $2, 1)", [part, wo]))).message).toMatch(/not found/);
    });
  });
});
