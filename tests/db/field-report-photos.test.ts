// Photos on driver problem reports (migration 20261120011100): the driver who sent the report reserves up to 4 photo
// paths within the hour; the paths are company-scoped; people who may see the report see its photos (a delay report
// needs dispatch.view, as the report does), others and other companies see none; nobody writes the table directly.
// Fictional data, rolled back.
import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, planLoad, scheduledOrder } from "./fixtures";
import { TOP_LINE, pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

const submit = async (s: Session, assignment: string, kind: string, equipment = "") =>
  (await s.query<{ r: { report_id: string; created: boolean } }>("select public.driver_submit_field_report($1::jsonb) r", [
    JSON.stringify({ assignment_id: assignment, kind, equipment, description: "Flat tire on the left side", submission_key: crypto.randomUUID() }),
  ])).rows[0].r.report_id;
const begin = (s: Session, report: string, mime = "image/jpeg", size = 1000) =>
  s.query<{ path: string }>("select public.field_report_photo_begin($1, $2, $3) path", [report, mime, size]);

describe("field report photos", () => {
  it("the reporting driver adds photos; viewers of the report see them; everyone else is refused", async () => {
    await withSession(async (s) => {
      const office = await s.createUser("office");
      const mechanic = await s.createUser("mechanic");
      const driverUser = await s.createUser("driver");
      const otherDriverUser = await s.createUser("driver");
      const today = await businessToday(s);
      const f = await fleet(s, office, today);
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $1 where id = $2", [driverUser, f.d1]);
      await s.query("update public.drivers set user_id = $1 where id = $2", [otherDriverUser, f.d2]);
      const order = await scheduledOrder(s, office, addDays(today, -1), addDays(today, 2), addDays(today, -1));
      const load = await planLoad(s, order.id, today, "07:00", "09:00");
      const aId = await assign(s, load.load_id, f.t1, null, f.d1);

      await s.as(driverUser);
      const breakdown = await submit(s, aId, "breakdown", "truck");
      const delay = await submit(s, aId, "delay");
      const p1 = (await begin(s, breakdown)).rows[0].path;
      expect(p1).toMatch(new RegExp(`^${TOP_LINE}/field-reports/[0-9a-f-]{36}\\.jpg$`));
      expect((await begin(s, breakdown, "image/png")).rows[0].path).toMatch(/\.png$/);
      // Type and size are checked; the limit is 4 per report.
      expect((await pgError(begin(s, breakdown, "application/pdf"))).code).toBe("22023");
      expect((await pgError(begin(s, breakdown, "image/jpeg", 6 * 1024 * 1024))).code).toBe("22023");
      await begin(s, breakdown);
      await begin(s, breakdown);
      expect((await pgError(begin(s, breakdown))).message).toMatch(/At most 4/);
      await begin(s, delay);

      // Another driver cannot add to it; nobody inserts directly.
      await s.as(otherDriverUser);
      expect((await pgError(begin(s, breakdown))).code).toBe("P0002");
      await s.as(driverUser);
      expect((await pgError(s.query("insert into public.field_report_photos (company_id, report_id, object_path, mime_type, size_bytes) values ($1, $2, $3, 'image/jpeg', 10)", [TOP_LINE, breakdown, `${TOP_LINE}/field-reports/${crypto.randomUUID()}.jpg`]))).code).toBe("42501");

      // A failed upload is never shown and frees its place.
      await s.asAdmin();
      await s.query("update public.field_report_photos set failed_at = now() where object_path = $1", [p1]);
      await s.as(driverUser);
      await begin(s, breakdown);

      // An hour after the report: no more photos.
      await s.asAdmin();
      await s.query("set local session_replication_role = replica"); // reports are immutable; age this one for the test
      await s.query("update public.field_reports set created_at = now() - interval '61 minutes' where id = $1", [breakdown]);
      await s.query("set local session_replication_role = origin");
      await s.as(driverUser);
      expect((await pgError(begin(s, breakdown))).message).toMatch(/an hour/);

      // The office (field_reports.view + dispatch.view) sees both reports' photos and opens them; never a failed one.
      await s.as(office);
      const seen = (await s.query<{ report_id: string }>("select report_id from public.field_report_photos")).rows;
      expect(seen.filter((r) => r.report_id === breakdown)).toHaveLength(5);
      expect(seen.filter((r) => r.report_id === delay)).toHaveLength(1);
      const okPhoto = (await s.query<{ id: string }>("select id from public.field_report_photos where report_id = $1 and failed_at is null limit 1", [breakdown])).rows[0].id;
      const failedPhoto = (await s.query<{ id: string }>("select id from public.field_report_photos where object_path = $1", [p1])).rows[0].id;
      expect((await s.query<{ p: string | null }>("select public.field_report_photo_path($1) p", [okPhoto])).rows[0].p).toMatch(/field-reports/);
      expect((await s.query<{ p: string | null }>("select public.field_report_photo_path($1) p", [failedPhoto])).rows[0].p).toBeNull();

      // The mechanic sees equipment reports only, so the delay report's photo stays hidden.
      await s.as(mechanic);
      const mech = (await s.query<{ report_id: string }>("select report_id from public.field_report_photos")).rows;
      expect(mech.some((r) => r.report_id === breakdown)).toBe(true);
      expect(mech.some((r) => r.report_id === delay)).toBe(false);

      // The driver does not read the office's report list; another company sees nothing and cannot open a path.
      const other = await s.createCompany("Photos Other Co");
      const outsider = await s.createUser("owner", { companyId: other });
      await s.as(outsider);
      expect((await s.query("select 1 from public.field_report_photos")).rowCount).toBe(0);
      expect((await s.query<{ p: string | null }>("select public.field_report_photo_path($1) p", [okPhoto])).rows[0].p).toBeNull();
      expect((await pgError(begin(s, breakdown))).code).not.toBeUndefined();

      // History names the order.
      await s.asAdmin();
      expect((await s.query("select 1 from public.audit_events where action = 'field_report.photo_added' and entity_id = $1", [order.id])).rowCount).toBeGreaterThan(0);
    });
  });
});
