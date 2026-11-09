// Demo samples for the shop (2026-11-09): a part on order for the demo's waiting job and an outside repair with a
// vendor invoice and warranty. Created in a demo by its owner, refused for real companies, and added once.
import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);

describe("demo shop samples", () => {
  it("adds a part on order and an outside repair in a demo only, once", async () => {
    await withSession(async (s) => {
      const company = await s.createCompany(`Demo shop ${tag()}`);
      const owner = await s.createUser("owner", { companyId: company });
      await s.as(owner);
      const t = await insert(s, "trucks", { unit_number: `DS-${tag()}`, truck_type: "tri_axle_dump" });
      const wo = (title: string) => s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) r", [JSON.stringify({ truck_id: t, title })]).then((r) => r.rows[0].r.id);
      const waiting = await wo("Replace DEF level sensor");
      await s.query("select public.maintenance_set_status($1, 'awaiting_parts', 'DEF sensor')", [waiting]);
      const done = await wo("Radiator leak");
      await s.query("select public.maintenance_set_status($1, 'in_progress', '')", [done]);
      await s.query("select public.maintenance_set_status($1, 'completed', '')", [done]);

      // A real company: refused.
      expect((await pgError(s.query("select public.demo_part_wait_samples()"))).code).toBe("42501");
      expect((await pgError(s.query("select public.demo_outside_repair_samples()"))).code).toBe("42501");

      await s.asAdmin();
      await s.query("update public.companies set is_demo = true, demo_kind = 'prospect' where id = $1", [company]);
      await s.as(owner);
      expect((await s.query<{ n: number }>("select public.demo_part_wait_samples() n")).rows[0].n).toBe(2);
      expect((await s.query<{ n: number }>("select public.demo_outside_repair_samples() n")).rows[0].n).toBe(1);
      // Refresh adds nothing twice.
      expect((await s.query<{ n: number }>("select public.demo_part_wait_samples() n")).rows[0].n).toBe(0);
      expect((await s.query<{ n: number }>("select public.demo_outside_repair_samples() n")).rows[0].n).toBe(0);

      const waits = await s.query<{ work_order_id: string; status: string }>("select work_order_id, status from public.part_waits(null)");
      expect(waits.rows.every((w) => w.work_order_id === waiting && w.status === "waiting")).toBe(true);
      const warranty = await s.query<{ work_order_id: string; invoice_number: string }>("select work_order_id, invoice_number from public.vendor_warranties()");
      expect(warranty.rows).toEqual([{ work_order_id: done, invoice_number: "DEMO-INV-5521" }]);
    });
  });
});
