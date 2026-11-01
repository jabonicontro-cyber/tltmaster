// GPS and hours of service (B101, migration 20261120004900): the company picks its source; hand entry needs dispatch
// rights (a driver may enter only their own hours); the settings row (with the feed key's hash) is never readable; the
// feed finds the company by the key's hash, works only while the source is "feed", skips unknown trucks and drivers,
// and never writes into another company; other companies and roles see nothing.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

const hash = (k: string) => createHash("sha256").update(k).digest("hex");

describe("GPS and hours", () => {
  it("settings, hand entry, permissions and the provider feed", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const dispatcher = await s.createUser("dispatcher");
      const mechanic = await s.createUser("mechanic");
      const driverUser = await s.createUser("driver");
      const otherDriverUser = await s.createUser("driver");
      await s.as(owner);
      const unit = `GP-${randomUUID().slice(0, 4)}`;
      const truck = await insert(s, "trucks", { unit_number: unit, truck_type: "tri_axle_dump" });
      const driver = await insert(s, "drivers", { name: `Hours Driver ${randomUUID().slice(0, 4)}`, user_id: driverUser });
      const other = await insert(s, "drivers", { name: `Other Driver ${randomUUID().slice(0, 4)}`, user_id: otherDriverUser });
      const noLogin = await insert(s, "drivers", { name: `No Login ${randomUUID().slice(0, 4)}` });

      // Settings: owner only, validated, never readable directly.
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.telematics_save_settings('manual', 30)"))).code).toBe("42501");
      await s.as(owner);
      expect((await pgError(s.query("select public.telematics_save_settings('gps', 30)"))).code).toBe("22023");
      expect((await pgError(s.query("select public.telematics_save_settings('manual', 2)"))).code).toBe("22023");
      await s.query("select public.telematics_save_settings('manual', 45)");
      const status = (await s.query<{ r: { source: string; stale_minutes: number } }>("select public.telematics_status() r")).rows[0].r;
      expect(status).toMatchObject({ source: "manual", stale_minutes: 45 });
      expect((await pgError(s.query("select * from public.telematics_settings"))).code).toBe("42501");

      // Hand entry: dispatch records positions; a mechanic cannot; invalid values are refused.
      await s.as(dispatcher);
      await s.query("select public.telematics_record_position($1, 40.41, -86.89, null, 'At the quarry')", [truck]);
      expect((await pgError(s.query("select public.telematics_record_position($1, 95, -86.89)", [truck]))).code).toBe("22023");
      expect((await pgError(s.query("select public.telematics_record_position($1, 40, -86, now() + interval '1 day')", [truck]))).code).toBe("22023");
      await s.query("select public.telematics_record_hours($1, 'driving', 300, 400, 3000)", [driver]);
      // A driver without a sign-in (most drivers) can have hours entered by dispatch too.
      await s.query("select public.telematics_record_hours($1, 'on_duty', 600)", [noLogin]);
      expect((await pgError(s.query("select public.telematics_record_hours($1, 'resting', 300)", [driver]))).code).toBe("22023");
      expect((await pgError(s.query("select public.telematics_record_hours($1, 'driving', 2000)", [driver]))).code).toBe("22023");
      await s.as(mechanic);
      expect((await pgError(s.query("select public.telematics_record_position($1, 40.41, -86.89)", [truck]))).code).toBe("42501");
      expect(Number((await s.query<{ n: string }>("select count(*) n from public.vehicle_positions where truck_id = $1", [truck])).rows[0].n)).toBe(1);

      // A driver enters their own hours only, and sees only their own.
      await s.as(driverUser);
      await s.query("select public.telematics_record_hours($1, 'on_duty', 280)", [driver]);
      expect((await pgError(s.query("select public.telematics_record_hours($1, 'on_duty', 280)", [other]))).code).toBe("42501");
      const seen = (await s.query<{ driver_id: string; source: string }>("select driver_id, source from public.driver_hours")).rows;
      expect(seen.length).toBe(2);
      expect(seen.every((r) => r.driver_id === driver && r.source === "manual")).toBe(true);
      expect((await s.query("select 1 from public.vehicle_positions")).rows.length).toBe(0);
      expect((await pgError(s.query("insert into public.vehicle_positions (company_id, truck_id, recorded_at, latitude, longitude, source) values (private.current_company_id(), $1, now(), 1, 1, 'feed')", [truck]))).code).toBe("42501");

      // Feed key: owner stores the hash; signed-in users can never call the feed.
      const key = `tlk_${randomUUID()}`;
      await s.as(owner);
      await s.query("select public.telematics_set_feed_key($1, $2)", [hash(key), key.slice(-4)]);
      expect((await pgError(s.query("select public.telematics_set_feed_key('nothex', '')"))).code).toBe("22023");
      expect((await s.query<{ r: { feed_key_hint: string } }>("select public.telematics_status() r")).rows[0].r.feed_key_hint).toBe(key.slice(-4));
      expect((await pgError(s.query("select public.telematics_ingest($1, '{}'::jsonb)", [hash(key)]))).code).toBe("42501");

      // The feed (service role): refused while the source is not "feed", then accepted; unknown rows are skipped.
      const payload = {
        positions: [
          { truck: unit.toLowerCase(), latitude: 40.5, longitude: -86.8, speed_mph: 41, heading: 90 },
          { truck: "NO-SUCH-UNIT", latitude: 40.5, longitude: -86.8 },
          { truck: unit, latitude: "north", longitude: -86.8 },
        ],
        hours: [{ driver, duty_status: "driving", drive_minutes_left: 250 }, { driver: "Nobody At All", duty_status: "driving" }],
      };
      const ingest = async (k: string, p: unknown) => {
        await s.query("reset role");
        await s.query("set local role service_role");
        try {
          return (await s.query<{ r: { positions: number; hours: number; skipped: number } }>("select public.telematics_ingest($1, $2::jsonb) r", [k, JSON.stringify(p)])).rows[0].r;
        } finally {
          await s.query("reset role");
        }
      };
      expect((await pgError(ingest(hash(key), payload))).code).toBe("42501");
      await s.as(owner);
      await s.query("select public.telematics_save_settings('feed', 30)");
      expect((await pgError(ingest(hash("wrong"), payload))).code).toBe("28000");
      expect(await ingest(hash(key), payload)).toEqual({ positions: 1, hours: 1, skipped: 3 });
      expect((await pgError(ingest(hash(key), { positions: Array.from({ length: 1001 }, () => ({})) }))).code).toBe("22023");
      await s.as(owner);
      const feed = (await s.query<{ source: string; entered_by: string | null; speed_mph: string }>("select source, entered_by, speed_mph from public.vehicle_positions where truck_id = $1 and source = 'feed'", [truck])).rows;
      expect(feed).toEqual([{ source: "feed", entered_by: null, speed_mph: "41.0" }]);
      expect((await s.query<{ r: { last_feed_at: string | null } }>("select public.telematics_status() r")).rows[0].r.last_feed_at).not.toBeNull();

      // A new key replaces the old one; revoking stops the feed.
      const key2 = `tlk_${randomUUID()}`;
      await s.query("select public.telematics_set_feed_key($1, $2)", [hash(key2), key2.slice(-4)]);
      expect((await pgError(ingest(hash(key), payload))).code).toBe("28000");
      await s.as(owner);
      await s.query("select public.telematics_revoke_feed_key()");
      expect((await pgError(ingest(hash(key2), payload))).code).toBe("28000");

      // Demo samples are refused for a real company.
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_telematics_samples()"))).code).toBe("42501");

      // Another company sees nothing and cannot record against these trucks or drivers.
      const elsewhere = await s.createCompany("Telematics Elsewhere");
      const outsider = await s.createUser("owner", { companyId: elsewhere });
      await s.as(outsider);
      expect((await s.query("select 1 from public.vehicle_positions")).rows.length).toBe(0);
      expect((await s.query("select 1 from public.driver_hours")).rows.length).toBe(0);
      expect((await pgError(s.query("select public.telematics_record_position($1, 40, -86)", [truck]))).code).toBe("P0002");
      expect((await pgError(s.query("select public.telematics_record_hours($1, 'driving', 100)", [driver]))).code).toBe("P0002");
      expect((await s.query<{ r: { source: string } }>("select public.telematics_status() r")).rows[0].r.source).toBe("none");
    });
  });
});
