// Work order photos and dump-body items (UX9, 20261120006700): the driver who reported a defect adds photos to the
// work order their inspection opened (that day); the shop adds photos to open work orders; others are refused; at most
// 8; only maintenance viewers or the uploader read the path. Dump trucks check the dump body, tractors do not.
import { afterAll, describe, expect, it } from "vitest";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

const DVIR = ["service_brakes", "parking_brake", "steering", "lights_reflectors", "tires", "wheels_rims", "coupling", "horn", "wipers", "mirrors", "emergency_equipment"];
const DUMP = ["air_lines", "hoist_body", "pto", "tarp", "tailgate"];
const items = (keys: string[], bad: Record<string, string> = {}) => keys.map((key) => ({ key, ok: !(key in bad), note: bad[key] ?? "" }));

describe("work order photos and dump-body items", () => {
  it("lets the reporting driver and the shop add photos, refuses others, and checks the dump body on dump trucks only", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const f = await fleet(s, owner, today);
      const order = await scheduledOrder(s, owner, today);
      const load = await planLoad(s, order.id, today, "07:00", "09:00");
      await assign(s, load.load_id, f.t1, null, f.d1);
      const driverUser = await s.createUser("driver");
      const otherDriver = await s.createUser("driver");
      const mechanic = await s.createUser("mechanic");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      const submit = (truck: string, its: unknown) =>
        s.query<{ r: { id: string; defects: number; work_order: string | null } }>("select public.inspection_submit($1::jsonb) r", [JSON.stringify({ truck_id: truck, kind: "pre_trip", items: its })]);

      // A dump truck: its list includes the dump body; the DVIR list alone is refused. A dump-body defect is not a safety defect.
      await s.as(driverUser);
      const mine = (await s.query<{ r: Array<{ id: string; dump: boolean }> }>("select public.inspection_my_trucks() r")).rows[0].r;
      expect(mine).toEqual([expect.objectContaining({ id: f.t1, dump: true })]);
      expect((await pgError(submit(f.t1, items(DVIR)))).message).toMatch(/Check every item/);
      const r = (await submit(f.t1, items([...DVIR, ...DUMP], { tailgate: "Latch does not close (test)" }))).rows[0].r;
      expect(r.defects).toBe(1);
      await s.asAdmin();
      const wo = (await s.query<{ id: string; safety_critical: boolean }>("select id, safety_critical from public.work_orders where number = $1 and truck_id = $2", [r.work_order, f.t1])).rows[0];
      expect(wo.safety_critical).toBe(false);
      expect((await s.query("select service_status from public.trucks where id = $1", [f.t1])).rows[0].service_status).toBe("in_service");

      // The reporting driver adds a photo through the inspection; another driver cannot; a driver cannot add by work order.
      const begin = (who: string, fn: "inspection_photo_begin" | "work_order_photo_begin", id: string, mime = "image/jpeg", size = 1000) =>
        s.as(who).then(() => s.query<{ p: string }>(`select public.${fn}($1, $2, $3) p`, [id, mime, size]));
      const path = (await begin(driverUser, "inspection_photo_begin", r.id)).rows[0].p;
      expect(path).toMatch(/^[0-9a-f-]{36}\/maintenance\/[0-9a-f-]{36}\.jpg$/);
      expect((await pgError(begin(otherDriver, "inspection_photo_begin", r.id))).message).toMatch(/Inspection not found/);
      expect((await pgError(begin(driverUser, "work_order_photo_begin", wo.id))).code).toBe("42501");
      expect((await pgError(begin(driverUser, "inspection_photo_begin", r.id, "application/pdf"))).message).toMatch(/JPEG, PNG or WebP/);
      expect((await pgError(begin(driverUser, "inspection_photo_begin", r.id, "image/png", 6_000_000))).message).toMatch(/at most 5 MB/);

      // The shop adds photos to the work order, up to 8 in all.
      for (let i = 0; i < 7; i++) await begin(mechanic, "work_order_photo_begin", wo.id, "image/png");
      expect((await pgError(begin(mechanic, "work_order_photo_begin", wo.id))).message).toMatch(/At most 8 photos/);

      // Reading: the shop sees every photo; the driver only their own path; another driver none.
      await s.as(mechanic);
      const photos = (await s.query<{ id: string; uploaded_by: string }>("select id, uploaded_by from public.work_order_photos where work_order_id = $1", [wo.id])).rows;
      expect(photos).toHaveLength(8);
      const driversPhoto = photos.find((p) => p.uploaded_by === driverUser)!.id;
      const shopPhoto = photos.find((p) => p.uploaded_by === mechanic)!.id;
      expect((await s.query<{ p: string | null }>("select public.work_order_photo_path($1) p", [shopPhoto])).rows[0].p).toMatch(/\.png$/);
      await s.as(driverUser);
      expect((await s.query<{ p: string | null }>("select public.work_order_photo_path($1) p", [driversPhoto])).rows[0].p).toBe(path);
      expect((await s.query<{ p: string | null }>("select public.work_order_photo_path($1) p", [shopPhoto])).rows[0].p).toBeNull();
      expect((await s.query("select 1 from public.work_order_photos")).rowCount).toBe(0);
      await s.as(otherDriver);
      expect((await s.query<{ p: string | null }>("select public.work_order_photo_path($1) p", [driversPhoto])).rows[0].p).toBeNull();

      // A closed work order takes no more photos.
      await s.asAdmin();
      await s.query("delete from public.work_order_photos where work_order_id = $1", [wo.id]);
      await s.query("update public.work_orders set status = 'closed', closed_at = now() where id = $1", [wo.id]);
      expect((await pgError(begin(driverUser, "inspection_photo_begin", r.id))).message).toMatch(/closed/);

      // A tractor checks the DVIR items only.
      await s.as(owner);
      const tractor = await insert(s, "trucks", { unit_number: `TR-${Date.now().toString(36)}`, truck_type: "tractor" });
      await s.asAdmin();
      expect((await s.query<{ n: number }>("select count(*)::int n from private.inspection_items_for($1)", [tractor])).rows[0]?.n ?? 0).toBe(11);
    });
  });
});
