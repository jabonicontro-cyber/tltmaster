// Fleet registry: trucks, trailers, drivers, qualifications, service status,
// dispatch-readiness rules and company isolation.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { evaluateAssignment, type EligibilityQualification } from "@/lib/fleet/eligibility";
import { pgError, pool, TOP_LINE, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

type Row = Record<string, unknown>;

async function insertTruck(s: Session, values: Row = {}) {
  const row = { unit_number: `T-${Math.random().toString(36).slice(2, 7)}`, truck_type: "tri_axle_dump", ...values };
  const cols = Object.keys(row);
  const res = await s.query<{ id: string }>(
    `insert into public.trucks (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return res.rows[0].id;
}

async function insertTrailer(s: Session, values: Row = {}) {
  const row = { unit_number: `R-${Math.random().toString(36).slice(2, 7)}`, trailer_type: "end_dump", ...values };
  const cols = Object.keys(row);
  const res = await s.query<{ id: string }>(
    `insert into public.trailers (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return res.rows[0].id;
}

async function insertDriver(s: Session, values: Row = {}) {
  const row = { name: "Test Driver", ...values };
  const cols = Object.keys(row);
  const res = await s.query<{ id: string }>(
    `insert into public.drivers (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return res.rows[0].id;
}

async function addQual(s: Session, driverId: string, values: Row) {
  const row = { driver_id: driverId, ...values };
  const cols = Object.keys(row);
  const res = await s.query<{ id: string }>(
    `insert into public.driver_qualifications (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    Object.values(row),
  );
  return res.rows[0].id;
}

async function setService(s: Session, kind: "truck" | "trailer", id: string, status: string, reason = "", expected: string | null = null) {
  return s.query("select public.set_equipment_service_status($1, $2, $3::public.service_status, $4, $5::date)", [kind, id, status, reason, expected]);
}

async function eligibility(s: Session, truck: string | null, trailer: string | null, driver: string | null, on: string) {
  const r = await s.query<{ r: { eligible: boolean; blockers: string[]; warnings: string[] } }>(
    "select public.check_assignment_eligibility($1, $2, $3, $4::date) as r",
    [truck, trailer, driver, on],
  );
  return r.rows[0].r;
}

async function today(s: Session) {
  await s.asAdmin();
  return (await s.query<{ d: string }>("select private.business_today($1)::text as d", [TOP_LINE])).rows[0].d;
}

describe("trucks and trailers", () => {
  it("office creates and edits a truck; unit numbers are unique per company, ignoring case and spaces", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const id = await insertTruck(s, { unit_number: " 101 ", make: "Kenworth", model: "T880", model_year: 2021, weight_capacity: "22.5", weight_unit: "ton" });
      const t = (await s.query("select * from public.trucks where id = $1", [id])).rows[0];
      expect(t).toMatchObject({ unit_number: "101", company_id: TOP_LINE, service_status: "in_service", active: true, created_by: office, weight_capacity: "22.500", weight_unit: "ton", capacity_verified_at: null });
      expect((await pgError(insertTruck(s, { unit_number: "101" }))).code).toBe("23505");
      await s.query("update public.trucks set model = 'T880S', notes = 'Yard 2' where id = $1", [id]);
      const after = (await s.query("select model, updated_by from public.trucks where id = $1", [id])).rows[0];
      expect(after).toEqual({ model: "T880S", updated_by: office });
      await s.asAdmin();
      const audit = await s.query("select action from public.audit_events where entity_id = $1 order by occurred_at, action", [id]);
      expect(audit.rows.map((a) => a.action)).toEqual(["truck.created", "truck.updated"]);
    });
  });

  it("validates capacity units, VINs and years, and never invents capacity", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const cases: Row[] = [
        { weight_capacity: "20" }, // no unit
        { weight_unit: "ton" }, // unit without value
        { volume_capacity: "18" }, // no unit
        { weight_capacity: "0", weight_unit: "ton" },
        { vin: "1HGCM82633A00435" }, // 16 chars
        { vin: "1HGCM82633A00435O" }, // contains O
        { model_year: 1900 },
        { capacity_verified_at: new Date().toISOString() }, // verified without any capacity
        { plate_state: "Indiana" },
      ];
      for (const c of cases) {
        expect((await pgError(insertTruck(s, c))).code, JSON.stringify(c)).toBe("23514");
      }
      const id = await insertTruck(s, { weight_capacity: "45000", weight_unit: "lb", volume_capacity: "18", volume_unit: "cu_yd" });
      const t = (await s.query("select weight_capacity, weight_unit, volume_capacity, volume_unit from public.trucks where id = $1", [id])).rows[0];
      expect(t).toEqual({ weight_capacity: "45000.000", weight_unit: "lb", volume_capacity: "18.000", volume_unit: "cu_yd" });
      const unknown = await insertTruck(s);
      const u = (await s.query("select weight_capacity, volume_capacity, capacity_verified_at from public.trucks where id = $1", [unknown])).rows[0];
      expect(u).toEqual({ weight_capacity: null, volume_capacity: null, capacity_verified_at: null });
    });
  });

  it("records who verified a capacity and when — the client cannot backdate it", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      const id = await insertTruck(s, { weight_capacity: "22", weight_unit: "ton", capacity_verified_at: "2001-01-01T00:00:00Z", capacity_source: "Scale ticket" });
      const v = (await s.query<{ at: Date; by: string }>("select capacity_verified_at as at, capacity_verified_by as by from public.trucks where id = $1", [id])).rows[0];
      expect(v.by).toBe(owner);
      expect(v.at.getUTCFullYear()).toBeGreaterThan(2020);
      // Unrelated edit keeps the original stamp, even if the client resends another time.
      await s.query("update public.trucks set notes = 'x', capacity_verified_at = '2002-02-02' where id = $1", [id]);
      const kept = (await s.query<{ at: Date }>("select capacity_verified_at as at from public.trucks where id = $1", [id])).rows[0];
      expect(kept.at.getTime()).toBe(v.at.getTime());
      // Clearing the flag clears who verified it.
      await s.query("update public.trucks set weight_capacity = 23, capacity_verified_at = null where id = $1", [id]);
      const cleared = (await s.query("select capacity_verified_at, capacity_verified_by from public.trucks where id = $1", [id])).rows[0];
      expect(cleared).toEqual({ capacity_verified_at: null, capacity_verified_by: null });
    });
  });

  it("service status changes only through the function: reason required, history kept, trailer independent of its truck", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const truck = await insertTruck(s, { truck_type: "tractor" });
      const trailer = await insertTrailer(s, { default_truck_id: truck, compatible_truck_types: "{tractor}" });

      // Direct writes to status columns are refused; equipment cannot be deleted.
      expect((await pgError(s.query("update public.trucks set service_status = 'out_of_service', out_of_service_reason = 'x', out_of_service_since = now() where id = $1", [truck]))).code).toBe("42501");
      expect((await pgError(s.query("delete from public.trucks where id = $1", [truck]))).code).toBe("42501");

      expect((await pgError(setService(s, "truck", truck, "out_of_service", "  "))).message).toMatch(/reason/);
      expect((await pgError(setService(s, "truck", truck, "in_service"))).message).toMatch(/already in service/);
      expect((await pgError(setService(s, "truck", truck, "out_of_service", "Brakes", "2020-01-01"))).message).toMatch(/cannot be in the past/);
      const ret = addDays(await today(s), 5);
      await s.as(office);
      await setService(s, "truck", truck, "out_of_service", "Brake repair", ret);

      const t = (await s.query("select service_status, out_of_service_reason, expected_return_date::text as ret, out_of_service_since from public.trucks where id = $1", [truck])).rows[0];
      expect(t).toMatchObject({ service_status: "out_of_service", out_of_service_reason: "Brake repair", ret });
      expect(t.out_of_service_since).not.toBeNull();
      // The trailer keeps its own status.
      expect((await s.query("select service_status from public.trailers where id = $1", [trailer])).rows[0].service_status).toBe("in_service");
      await setService(s, "trailer", trailer, "out_of_service", "Tarp torn");
      await setService(s, "truck", truck, "in_service");
      const back = (await s.query("select service_status, out_of_service_reason, out_of_service_since, expected_return_date from public.trucks where id = $1", [truck])).rows[0];
      expect(back).toEqual({ service_status: "in_service", out_of_service_reason: "", out_of_service_since: null, expected_return_date: null });
      expect((await s.query("select service_status from public.trailers where id = $1", [trailer])).rows[0].service_status).toBe("out_of_service");

      const events = await s.query("select from_status, to_status, reason, actor_id from public.equipment_status_events where truck_id = $1 order by occurred_at, from_status", [truck]);
      expect(events.rows).toEqual([
        { from_status: "in_service", to_status: "out_of_service", reason: "Brake repair", actor_id: office },
        { from_status: "out_of_service", to_status: "in_service", reason: "", actor_id: office },
      ]);
      await s.asAdmin();
      expect((await pgError(s.query("delete from public.equipment_status_events where truck_id = $1", [truck]))).code).toBe("42501");
      const audit = await s.query("select count(*)::int as n from public.audit_events where entity_id = $1 and action = 'truck.updated'", [truck]);
      expect(audit.rows[0].n).toBe(2);
    });
  });
});

describe("drivers and qualifications", () => {
  it("links an existing company user instead of duplicating the person, and validates identity", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const driverUser = await s.createUser("driver");
      const B = await s.createCompany("Brookside Aggregates (test)");
      const outsider = await s.createUser("driver", { companyId: B });
      await s.as(office);
      const linked = await insertDriver(s, { user_id: driverUser, name: "" });
      const row = (await s.query("select display_name, account_active, account_role from public.driver_list where id = $1", [linked])).rows[0];
      expect(row).toEqual({ display_name: "Test driver", account_active: true, account_role: "driver" });
      expect((await pgError(insertDriver(s, { user_id: driverUser }))).code).toBe("23505");
      expect((await pgError(insertDriver(s, { user_id: outsider }))).code).toBe("23503");
      expect((await pgError(insertDriver(s, { name: "  " }))).code).toBe("23514");
      await insertDriver(s, { name: "Sam Hauler", employee_number: "E-7" });
      expect((await pgError(insertDriver(s, { name: "Other", employee_number: "e-7" }))).code).toBe("23505");
    });
  });

  it("qualifications need a class for CDLs; verification is stamped by the database and cleared on request", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const d = await insertDriver(s);
      expect((await pgError(addQual(s, d, { kind: "cdl" }))).code).toBe("23514");
      expect((await pgError(addQual(s, d, { kind: "medical_card", cdl_class: "A" }))).code).toBe("23514");
      expect((await pgError(addQual(s, d, { kind: "other" }))).code).toBe("23514");
      expect((await pgError(addQual(s, d, { kind: "cdl", cdl_class: "A", issued_on: "2026-01-01", expires_on: "2025-01-01" }))).code).toBe("23514");
      const q = await addQual(s, d, { kind: "cdl", cdl_class: "A", expires_on: "2030-01-01", verified_at: "1999-01-01" });
      const v = (await s.query<{ verified_by: string; at: Date }>("select verified_by, verified_at as at from public.driver_qualifications where id = $1", [q])).rows[0];
      expect(v.verified_by).toBe(office);
      expect(v.at.getUTCFullYear()).toBeGreaterThan(2020);
      await s.query("update public.driver_qualifications set expires_on = '2031-01-01', verified_at = null where id = $1", [q]);
      expect((await s.query("select verified_at, verified_by from public.driver_qualifications where id = $1", [q])).rows[0]).toEqual({ verified_at: null, verified_by: null });
      await s.query("delete from public.driver_qualifications where id = $1", [q]);
      await s.asAdmin();
      const audit = await s.query("select action from public.audit_events where entity_id = $1 order by occurred_at", [q]);
      expect(audit.rows.map((a) => a.action).sort()).toEqual(["driver_qualification.created", "driver_qualification.deleted", "driver_qualification.updated"]);
    });
  });
});

describe("permissions", () => {
  it("applies the role conventions", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      await s.as(office);
      const truck = await insertTruck(s);
      const driver = await insertDriver(s);

      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await s.query("select id from public.trucks where id = $1", [truck])).rowCount).toBe(1);
      expect((await pgError(insertTruck(s))).code).toBe("42501");
      expect((await s.query("update public.trucks set notes = 'x' where id = $1 returning id", [truck])).rowCount).toBe(0);
      expect((await pgError(setService(s, "truck", truck, "out_of_service", "x"))).code).toBe("42501");
      expect((await pgError(addQual(s, driver, { kind: "medical_card" }))).code).toBe("42501");

      const mechanic = await s.createUser("mechanic");
      await s.as(mechanic);
      expect((await s.query("select id from public.trucks where id = $1", [truck])).rowCount).toBe(1);
      expect((await pgError(insertTruck(s))).code).toBe("42501");
      await setService(s, "truck", truck, "out_of_service", "Oil leak");

      for (const role of ["driver", null] as const) {
        const u = await s.createUser(role);
        await s.as(u);
        expect((await s.query("select id from public.trucks")).rowCount, String(role)).toBe(0);
        expect((await s.query("select id from public.drivers")).rowCount, String(role)).toBe(0);
        expect((await pgError(eligibility(s, truck, null, null, "2026-10-10"))).code, String(role)).toBe("42501");
      }
      await s.as(null);
      expect((await pgError(s.query("select id from public.trucks"))).code).toBe("42501");
    });
  });
});

describe("dispatch readiness", () => {
  it("database and app rules agree on every scenario", async () => {
    await withSession(async (s) => {
      const on = await today(s);
      const owner = await s.createUser("owner");
      await s.as(owner);
      const far = addDays(on, 400);
      const soon = addDays(on, 10);
      const past = addDays(on, -1);
      const verified = new Date().toISOString();

      const trucks = {
        dump: await insertTruck(s, { truck_type: "tri_axle_dump", weight_capacity: "22", weight_unit: "ton", capacity_verified_at: verified }),
        tractor: await insertTruck(s, { truck_type: "tractor", weight_capacity: "25", weight_unit: "ton" }),
        unknownCap: await insertTruck(s, { truck_type: "quad_axle_dump" }),
        inactive: await insertTruck(s, { truck_type: "tri_axle_dump", active: false }),
        down: await insertTruck(s, { truck_type: "tractor" }),
      };
      await setService(s, "truck", trucks.down, "out_of_service", "Engine");
      const trailers = {
        forTractor: await insertTrailer(s, { compatible_truck_types: "{tractor}", volume_capacity: "24", volume_unit: "cu_yd", capacity_verified_at: verified }),
        compatUnknown: await insertTrailer(s, {}),
        down: await insertTrailer(s, { compatible_truck_types: "{tractor}" }),
      };
      await setService(s, "trailer", trailers.down, "out_of_service", "Hydraulics");

      const quals: Record<string, Row[]> = {
        good: [{ kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified }, { kind: "medical_card", expires_on: far, verified_at: verified }],
        classB: [{ kind: "cdl", cdl_class: "B", expires_on: far, verified_at: verified }, { kind: "medical_card", expires_on: far, verified_at: verified }],
        classC: [{ kind: "cdl", cdl_class: "C", expires_on: far, verified_at: verified }, { kind: "medical_card", expires_on: far, verified_at: verified }],
        expired: [{ kind: "cdl", cdl_class: "A", expires_on: past, verified_at: verified }, { kind: "medical_card", expires_on: far, verified_at: verified }],
        unverified: [{ kind: "cdl", cdl_class: "A", expires_on: far }, { kind: "medical_card", expires_on: far, verified_at: verified }],
        noExpiry: [{ kind: "cdl", cdl_class: "A", verified_at: verified }, { kind: "medical_card", expires_on: far, verified_at: verified }],
        noMedical: [{ kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified }],
        medicalSoon: [{ kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified }, { kind: "medical_card", expires_on: soon, verified_at: verified }],
        renewed: [
          { kind: "cdl", cdl_class: "A", expires_on: past, verified_at: verified },
          { kind: "cdl", cdl_class: "A", expires_on: far, verified_at: verified },
          { kind: "medical_card", expires_on: far, verified_at: verified },
        ],
        none: [],
      };
      const drivers: Record<string, string> = {};
      for (const [k, qs] of Object.entries(quals)) {
        drivers[k] = await insertDriver(s, { name: `Driver ${k}` });
        for (const q of qs) await addQual(s, drivers[k], q);
      }
      drivers.inactive = await insertDriver(s, { name: "Inactive", active: false });
      for (const q of quals.good) await addQual(s, drivers.inactive, q);

      // Load what the app would load, then compare the two implementations.
      // (node-postgres returns enum arrays as text; PostgREST returns JSON arrays.)
      const load = async (table: string, id: string | null) =>
        id ? (await s.query(`select *${table === "trailers" ? ", compatible_truck_types::text[] as compatible_truck_types" : ""} from public.${table} where id = $1`, [id])).rows[0] : null;
      const loadDriver = async (id: string | null) => {
        if (!id) return null;
        const d = await load("drivers", id);
        const q = (await s.query<EligibilityQualification>("select kind, cdl_class, expires_on::text, verified_at::text from public.driver_qualifications where driver_id = $1", [id])).rows;
        return { active: d!.active as boolean, qualifications: q };
      };

      const scenarios: Array<[string | null, string | null, string | null, { eligible: boolean; blockers?: string[]; warnings?: string[] }?]> = [
        [trucks.dump, null, drivers.good, { eligible: true, blockers: [], warnings: [] }],
        [trucks.dump, null, drivers.classB, { eligible: true }],
        [trucks.dump, null, drivers.classC, { eligible: false, blockers: ["cdl_class_insufficient"] }],
        [trucks.tractor, trailers.forTractor, drivers.good, { eligible: true, warnings: ["truck_capacity_unverified"] }],
        [trucks.tractor, trailers.forTractor, drivers.classB, { eligible: false, blockers: ["cdl_class_insufficient"] }],
        [trucks.dump, trailers.forTractor, drivers.good, { eligible: false, blockers: ["trailer_incompatible"] }],
        [trucks.tractor, trailers.compatUnknown, null, { eligible: true, warnings: ["truck_capacity_unverified", "trailer_capacity_unknown", "trailer_compatibility_unknown"] }],
        [trucks.down, trailers.down, null, { eligible: false, blockers: ["truck_out_of_service", "trailer_out_of_service"] }],
        [trucks.inactive, null, null, { eligible: false, blockers: ["truck_inactive"] }],
        [trucks.unknownCap, null, null, { eligible: true, warnings: ["truck_capacity_unknown"] }],
        [null, null, drivers.expired, { eligible: false, blockers: ["cdl_expired"] }],
        [null, null, drivers.unverified, { eligible: false, blockers: ["cdl_unverified"] }],
        [null, null, drivers.noExpiry, { eligible: false, blockers: ["cdl_expiry_unknown"] }],
        [null, null, drivers.noMedical, { eligible: false, blockers: ["medical_card_missing"] }],
        [null, null, drivers.medicalSoon, { eligible: true, warnings: ["medical_card_expiring_soon"] }],
        [null, null, drivers.renewed, { eligible: true }],
        [null, null, drivers.none, { eligible: false, blockers: ["cdl_missing", "medical_card_missing"] }],
        [null, null, drivers.inactive, { eligible: false, blockers: ["driver_inactive"] }],
        [trucks.down, trailers.compatUnknown, drivers.unverified],
        [trucks.tractor, trailers.down, drivers.classC],
      ];
      for (const [truck, trailer, driver, expected] of scenarios) {
        const label = JSON.stringify({ truck, trailer, driver });
        const db = await eligibility(s, truck, trailer, driver, on);
        const app = evaluateAssignment({ truck: (await load("trucks", truck)) as never, trailer: (await load("trailers", trailer)) as never, driver: await loadDriver(driver) }, on);
        expect(app, label).toEqual({ eligible: db.eligible, blockers: db.blockers, warnings: db.warnings });
        if (expected) expect(db, label).toMatchObject(expected);
      }

      // A date in the future: the expiring medical card becomes expired.
      const later = await eligibility(s, null, null, drivers.medicalSoon, addDays(on, 20));
      expect(later.blockers).toEqual(["medical_card_expired"]);
    });
  });
});

describe("company isolation", () => {
  it("another company cannot see, reference or change Top Line fleet records", async () => {
    await withSession(async (s) => {
      const tlOffice = await s.createUser("office");
      const tlDriverUser = await s.createUser("driver");
      await s.as(tlOffice);
      const tlTruck = await insertTruck(s, { unit_number: "201" });
      const tlTrailer = await insertTrailer(s, { unit_number: "R1" });
      const tlDriver = await insertDriver(s);
      const tlQual = await addQual(s, tlDriver, { kind: "medical_card", expires_on: "2030-01-01" });

      const B = await s.createCompany("Brookside Aggregates (test)");
      const bOwner = await s.createUser("owner", { companyId: B });
      await s.as(bOwner);
      for (const [table, id] of [["trucks", tlTruck], ["trailers", tlTrailer], ["drivers", tlDriver], ["driver_list", tlDriver], ["driver_qualifications", tlQual]] as const) {
        expect((await s.query(`select id from public.${table} where id = $1`, [id])).rowCount, table).toBe(0);
      }
      expect((await s.query("update public.trucks set notes = 'x' where id = $1 returning id", [tlTruck])).rowCount).toBe(0);
      expect((await s.query("delete from public.driver_qualifications where id = $1 returning id", [tlQual])).rowCount).toBe(0);

      // Same unit number is fine in another company.
      const bTruck = await insertTruck(s, { unit_number: "201" });
      expect((await s.query("select company_id from public.trucks where id = $1", [bTruck])).rows[0].company_id).toBe(B);

      // References to Top Line records are refused by the composite foreign keys.
      expect((await pgError(insertTrailer(s, { default_truck_id: tlTruck }))).code).toBe("23503");
      expect((await pgError(addQual(s, tlDriver, { kind: "medical_card" }))).code).toBe("23503");
      expect((await pgError(insertDriver(s, { user_id: tlDriverUser }))).code).toBe("23503");
      expect((await pgError(insertTruck(s, { company_id: TOP_LINE }))).code).toBe("42501");

      // Functions refuse Top Line ids.
      expect((await pgError(setService(s, "truck", tlTruck, "out_of_service", "hijack"))).message).toMatch(/not found/);
      expect((await pgError(setService(s, "trailer", tlTrailer, "out_of_service", "hijack"))).message).toMatch(/not found/);
      expect((await pgError(eligibility(s, tlTruck, null, null, "2026-10-10"))).message).toMatch(/Truck not found/);
      expect((await pgError(eligibility(s, null, null, tlDriver, "2026-10-10"))).message).toMatch(/Driver not found/);
      expect((await s.query("select 1 from public.audit_events where entity_id = $1", [tlTruck])).rowCount).toBe(0);

      await s.asAdmin();
      expect((await s.query("select service_status from public.trucks where id = $1", [tlTruck])).rows[0].service_status).toBe("in_service");
    });
  });
});
