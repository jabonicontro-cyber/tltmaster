import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const tag = () => Math.random().toString(36).slice(2, 7);

async function truck(s: Session, owner: string) {
  await s.as(owner);
  return insert(s, "trucks", { unit_number: `F-${tag()}`, truck_type: "tri_axle_dump" });
}

async function driver(s: Session, owner: string, name = `Driver ${tag()}`) {
  await s.as(owner);
  return insert(s, "drivers", { name });
}

describe("vehicle documents", () => {
  it("fleet.edit records them; fleet.view reads them; other companies see nothing", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const office = await s.createUser("office");
      const dispatcher = await s.createUser("dispatcher");
      const driverUser = await s.createUser("driver");
      const t = await truck(s, owner);

      await s.as(office);
      const doc = await insert(s, "vehicle_documents", { truck_id: t, kind: "registration", reference_number: "REG-1", issuing_authority: "IN BMV", expires_on: "2027-03-31" });

      await s.as(dispatcher);
      expect((await s.query("select id from public.vehicle_documents where id = $1", [doc])).rowCount).toBe(1);
      expect((await pgError(insert(s, "vehicle_documents", { truck_id: t, kind: "insurance" }))).code).toBe("42501");
      expect((await s.query("update public.vehicle_documents set notes = 'x' where id = $1", [doc])).rowCount).toBe(0);

      await s.as(driverUser);
      expect((await s.query("select id from public.vehicle_documents")).rowCount).toBe(0);

      const other = await s.createCompany(`Other ${tag()}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.vehicle_documents where id = $1", [doc])).rowCount).toBe(0);
      // Another company's truck cannot receive a document.
      expect((await pgError(insert(s, "vehicle_documents", { truck_id: t, kind: "permit" }))).code).toBe("23503");

      // Nobody deletes documents: they are archived.
      await s.as(owner);
      expect((await pgError(s.query("delete from public.vehicle_documents where id = $1", [doc]))).code).toBe("42501");
    });
  });

  it("rejects invalid data: two vehicles, expiry before issue, untitled 'other', moving or un-archiving", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const t2 = await truck(s, owner);
      const trailer = await insert(s, "trailers", { unit_number: `TR-${tag()}`, trailer_type: "end_dump" });
      expect((await pgError(insert(s, "vehicle_documents", { truck_id: t, trailer_id: trailer, kind: "permit" }))).code).toBe("23514");
      expect((await pgError(insert(s, "vehicle_documents", { truck_id: t, kind: "insurance", issued_on: "2026-05-01", expires_on: "2026-04-01" }))).code).toBe("23514");
      expect((await pgError(insert(s, "vehicle_documents", { truck_id: t, kind: "other" }))).code).toBe("23514");
      const doc = await insert(s, "vehicle_documents", { trailer_id: trailer, kind: "inspection", expires_on: "2026-01-01" });
      expect((await pgError(s.query("update public.vehicle_documents set truck_id = $2, trailer_id = null where id = $1", [doc, t2]))).code).toBe("42501"); // column not updatable
      await s.query("update public.vehicle_documents set archived_at = now() where id = $1", [doc]);
      const row = (await s.query("select archived_by from public.vehicle_documents where id = $1", [doc])).rows[0];
      expect(row.archived_by).toBe(owner);
      expect((await pgError(s.query("update public.vehicle_documents set archived_at = null where id = $1", [doc]))).message).toMatch(/cannot be restored/);
    });
  });

  it("the same submission key never creates a second document", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const key = crypto.randomUUID();
      await insert(s, "vehicle_documents", { truck_id: t, kind: "insurance", submission_key: key });
      expect((await pgError(insert(s, "vehicle_documents", { truck_id: t, kind: "insurance", submission_key: key }))).code).toBe("23505");
    });
  });
});

describe("ownership", () => {
  it("is recorded with fleet.edit only and limited to known values", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const t = await truck(s, owner);
      await s.query("update public.trucks set ownership = 'leased' where id = $1", [t]);
      expect((await pgError(s.query("update public.trucks set ownership = 'borrowed' where id = $1", [t]))).code).toBe("23514");
      await s.as(dispatcher);
      expect((await s.query("update public.trucks set ownership = 'owned' where id = $1", [t])).rowCount).toBe(0);
    });
  });
});

describe("truck assignments", () => {
  it("assigns, reassigns and removes atomically, keeping history; one truck per driver and one driver per truck", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const t1 = await truck(s, owner);
      const t2 = await truck(s, owner);
      const a = await driver(s, owner, `Alpha ${tag()}`);
      const b = await driver(s, owner, `Bravo ${tag()}`);

      await s.as(dispatcher);
      const assign = (truckId: string, driverId: string | null) => s.query("select public.assign_truck_driver($1, $2) as r", [truckId, driverId]);
      await assign(t1, a);
      await assign(t1, b); // reassign: A loses it
      await assign(t2, a);
      await assign(t2, b); // B moves from T1 to T2; A unassigned; T1 now free
      const holders = await s.query<{ id: string; primary_truck_id: string | null }>("select id, primary_truck_id from public.drivers where id in ($1, $2)", [a, b]);
      expect(Object.fromEntries(holders.rows.map((r) => [r.id, r.primary_truck_id]))).toEqual({ [a]: null, [b]: t2 });
      expect((await assign(t2, b)).rows[0].r.changed).toBe(false); // same again: nothing changes

      const history = await s.query<{ truck_id: string; driver_id: string; action: string }>(
        "select truck_id, driver_id, action from public.truck_assignment_events where truck_id in ($1, $2) order by created_at, id", [t1, t2]);
      expect(history.rows.map((h) => `${h.truck_id === t1 ? "T1" : "T2"}:${h.driver_id === a ? "A" : "B"}:${h.action}`)).toEqual([
        "T1:A:assigned", "T1:A:unassigned", "T1:B:assigned", "T2:A:assigned", "T2:A:unassigned", "T1:B:unassigned", "T2:B:assigned",
      ]);

      await assign(t2, null);
      expect((await s.query("select primary_truck_id from public.drivers where id = $1", [b])).rows[0].primary_truck_id).toBeNull();
      // History cannot be written by app users.
      expect((await pgError(s.query("insert into public.truck_assignment_events (company_id, truck_id, driver_id, action) select company_id, id, $2, 'assigned' from public.trucks where id = $1", [t1, a]))).code).toBe("42501");
    });
  });

  it("needs fleet.assign and refuses other companies' trucks and drivers", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const d = await driver(s, owner);
      for (const role of ["mechanic", "office", "driver"] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await pgError(s.query("select public.assign_truck_driver($1, $2)", [t, d]))).code, role).toBe("42501");
      }
      const other = await s.createCompany(`Other ${tag()}`);
      const otherOwner = await s.createUser("owner", { companyId: other });
      const ot = await truck(s, otherOwner);
      await s.as(owner);
      expect((await pgError(s.query("select public.assign_truck_driver($1, $2)", [ot, d]))).code).toBe("P0002");
      await s.as(otherOwner);
      expect((await pgError(s.query("select public.assign_truck_driver($1, $2)", [ot, d]))).code).toBe("P0002");
    });
  });

  it("assigning a driver never returns a safety-restricted truck to service", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const t = await truck(s, owner);
      const d = await driver(s, owner);
      await s.query("select public.maintenance_create_work_order($1::jsonb)", [JSON.stringify({ truck_id: t, title: "Steering box leak", safety_critical: true })]);
      await s.query("select public.assign_truck_driver($1, $2)", [t, d]);
      expect((await s.query("select service_status::text as s from public.trucks where id = $1", [t])).rows[0].s).toBe("out_of_service");
      expect((await pgError(s.query("select public.set_equipment_service_status('truck', $1, 'in_service')", [t]))).message).toMatch(/safety-critical work order/);
    });
  });
});
