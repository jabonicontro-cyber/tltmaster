import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

// Route Planner core (20261120002600) and the yard grant (20261120002700): saved locations, truck routing dimensions
// and saved routes are company records under RLS; the yard is saved by people with settings.manage.

describe("route planner", () => {
  it("an owner saves the yard; a dispatcher cannot change company settings", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      await s.as(owner);
      const r = await s.query("update public.company_settings set yard_latitude = 40.93, yard_longitude = -87.15 where company_id is not null returning company_id");
      expect(r.rowCount).toBe(1);
      await s.as(dispatcher);
      const d = await s.query("update public.company_settings set yard_latitude = 1, yard_longitude = 1 where company_id is not null returning company_id");
      expect(d.rowCount).toBe(0); // RLS: no row to update without settings.manage
      // Both or neither.
      await s.as(owner);
      expect((await pgError(s.query("update public.company_settings set yard_latitude = 41 , yard_longitude = null where company_id is not null"))).message).toMatch(/yard_pair/);
    });
  });

  it("locations: dispatchers add them, drivers cannot, and a located place records its source", async () => {
    await withSession(async (s) => {
      const dispatcher = await s.createUser("dispatcher");
      const driver = await s.createUser("driver");
      await s.as(dispatcher);
      const id = await insert(s, "company_locations", { kind: "quarry", name: "Test Pit (test)", latitude: 40.1, longitude: -88.9, location_source: "manual" });
      expect(id).toBeTruthy();
      // A point needs a source, and a source needs a point.
      expect((await pgError(s.query("insert into public.company_locations (kind, name, latitude, longitude) values ('plant', 'No source', 40, -88)"))).code).toBe("23514");
      expect((await pgError(s.query("insert into public.company_locations (kind, name, location_source) values ('plant', 'No point', 'manual')"))).code).toBe("23514");
      await s.as(driver);
      expect((await pgError(s.query("insert into public.company_locations (kind, name) values ('yard', 'Driver yard')"))).code).toBe("42501");
      const seen = await s.query("select id from public.company_locations where id = $1", [id]);
      expect(seen.rowCount).toBe(0); // drivers have neither dispatch.view nor orders.view
    });
  });

  it("saved routes keep stops in order with exactly one place each, and another company sees none of it", async () => {
    await withSession(async (s) => {
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      const loc = await insert(s, "company_locations", { kind: "yard", name: "Yard (test)", latitude: 40.1, longitude: -88.9, location_source: "manual" });
      const route = await insert(s, "saved_routes", { name: `Route ${randomUUID().slice(0, 6)}` });
      await s.query("insert into public.saved_route_stops (route_id, position, company_location_id) values ($1, 1, $2)", [route, loc]);
      await s.query("insert into public.saved_route_stops (route_id, position, latitude, longitude, label) values ($1, 2, 40.2, -88.8, 'Typed point')", [route]);
      expect((await pgError(s.query("insert into public.saved_route_stops (route_id, position, company_location_id, latitude, longitude) values ($1, 3, $2, 1, 1)", [route, loc]))).code).toBe("23514");
      expect((await pgError(s.query("insert into public.saved_route_stops (route_id, position, label) values ($1, 3, 'Nowhere')", [route]))).code).toBe("23514");
      expect((await pgError(s.query("insert into public.saved_route_stops (route_id, position, latitude, longitude) values ($1, 26, 1, 1)", [route]))).code).toBe("23514");

      const other = await s.createCompany(`Other Hauling ${randomUUID().slice(0, 6)} (test)`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [other, outsider]);
      await s.as(outsider);
      for (const [table, id] of [["company_locations", loc], ["saved_routes", route]] as const) {
        expect((await s.query(`select id from public.${table} where id = $1`, [id])).rowCount).toBe(0);
        expect((await s.query(`update public.${table} set name = 'taken' where id = $1 returning id`, [id])).rowCount).toBe(0);
      }
      expect((await s.query("select id from public.saved_route_stops where route_id = $1", [route])).rowCount).toBe(0);
      // Nor can it attach a stop to the first company's route or location.
      expect((await pgError(s.query("insert into public.saved_route_stops (route_id, position, latitude, longitude) values ($1, 3, 1, 1)", [route]))).code).toMatch(/42501|23503/);
      const own = await insert(s, "saved_routes", { name: "Theirs" });
      expect((await pgError(s.query("insert into public.saved_route_stops (route_id, position, company_location_id) values ($1, 1, $2)", [own, loc]))).code).toBe("23503");
    });
  });

  it("truck routing dimensions are validated", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const truck = await insert(s, "trucks", { unit_number: `RP-${randomUUID().slice(0, 5)}`, truck_type: "tri_axle_dump" });
      await s.query("update public.trucks set height_cm = 396, width_cm = 259, length_cm = 1036, gross_weight_kg = 33112, axle_count = 4 where id = $1", [truck]);
      expect((await pgError(s.query("update public.trucks set height_cm = 0 where id = $1", [truck]))).code).toBe("23514");
    });
  });
});
