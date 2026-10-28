// Safety incidents (B103, migration 20261120004300): a driver reports as themselves and sees only their own reports'
// status; safety.view reads the company's incidents; investigating, actions and closing need safety.manage; closing
// needs findings and every action done; another company sees nothing.
import { afterAll, describe, expect, it } from "vitest";
import { businessToday, fleet } from "./fixtures";
import { pgError, pool, withSession } from "./helpers";

afterAll(() => pool.end());

describe("safety incidents", () => {
  it("goes from a driver's report through investigation and actions to closed", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      const today = await businessToday(s);
      const f = await fleet(s, owner, today);
      const driverUser = await s.createUser("driver");
      await s.asAdmin();
      await s.query("update public.drivers set user_id = $2 where id = $1", [f.d1, driverUser]);
      const now = new Date().toISOString();

      // The driver reports; the driver on the report is always their own record, whatever was sent.
      await s.as(driverUser);
      const r = (await s.query<{ r: { id: string; number: string } }>("select public.safety_report($1::jsonb) r", [
        JSON.stringify({ kind: "accident", severity: "moderate", occurred_at: now, description: "Mirror hit the gate post", truck_id: f.t1, driver_id: f.d2, vehicle_damage: true }),
      ])).rows[0].r;
      expect(r.number).toMatch(/^INC-\d{4}$/);
      expect((await pgError(s.query("select public.safety_report($1::jsonb)", [JSON.stringify({ kind: "accident", occurred_at: now, description: " " })]))).message).toMatch(/Describe what happened/);
      expect((await pgError(s.query("select public.safety_report($1::jsonb)", [JSON.stringify({ kind: "accident", occurred_at: "2999-01-01T00:00:00Z", description: "x" })]))).message).toMatch(/future/);
      // The driver sees the status of their own report, not the incidents table or the investigation.
      expect((await s.query("select * from public.safety_incidents")).rowCount).toBe(0);
      const mine = (await s.query<{ number: string; status: string }>("select number, status from public.my_safety_reports()")).rows;
      expect(mine).toEqual([{ number: r.number, status: "reported" }]);
      const photo = (await s.query<{ r: string }>("select public.safety_photo_begin($1, 'image/jpeg', 2000) r", [r.id])).rows[0].r;
      expect(photo).toMatch(/\/safety\/[0-9a-f-]{36}\.jpg$/);
      expect((await pgError(s.query("select public.safety_photo_begin($1, 'application/pdf', 2000)", [r.id]))).message).toMatch(/JPEG, PNG or WebP/);
      expect((await pgError(s.query("select public.safety_investigate($1, '{}'::jsonb)", [r.id]))).message).toMatch(/permission/);

      await s.asAdmin();
      const row = (await s.query<{ driver_id: string; reported_by: string }>("select driver_id, reported_by from public.safety_incidents where id = $1", [r.id])).rows[0];
      expect(row).toEqual({ driver_id: f.d1, reported_by: driverUser });

      // Dispatch reads it but cannot investigate.
      const dispatcher = await s.createUser("dispatcher");
      await s.as(dispatcher);
      expect((await s.query("select id from public.safety_incidents where id = $1", [r.id])).rowCount).toBe(1);
      expect((await pgError(s.query("select public.safety_close($1, '')", [r.id]))).message).toMatch(/permission/);

      // The owner investigates, adds a witness and an action; closing waits for findings and the action.
      await s.as(owner);
      expect((await pgError(s.query("select public.safety_close($1, '')", [r.id]))).message).toMatch(/findings/);
      await s.query("select public.safety_investigate($1, $2::jsonb)", [r.id, JSON.stringify({ findings: "Narrow gate", root_cause: "Unfamiliar site", severity: "minor" })]);
      await s.query("select public.safety_add_witness($1, 'Site foreman', '555-0100', 'Saw the mirror hit')", [r.id]);
      const action = (await s.query<{ r: string }>("select public.safety_add_action($1, 'Add the gate to site directions', $2, $3) r", [r.id, dispatcher, today])).rows[0].r;
      expect((await s.query<{ status: string }>("select status from public.safety_incidents where id = $1", [r.id])).rows[0].status).toBe("actions_open");
      expect((await pgError(s.query("select public.safety_close($1, '')", [r.id]))).message).toMatch(/Every corrective action/);

      // The person the action was given to completes it; then the owner closes.
      await s.as(dispatcher);
      await s.query("select public.safety_complete_action($1, 'Done')", [action]);
      await s.as(owner);
      await s.query("select public.safety_close($1, 'Briefed all drivers')", [r.id]);
      const closed = (await s.query<{ status: string; severity: string; findings: string }>("select status, severity, findings from public.safety_incidents where id = $1", [r.id])).rows[0];
      expect(closed).toEqual({ status: "closed", severity: "minor", findings: "Narrow gate" });
      const events = (await s.query<{ action: string }>("select action from public.safety_incident_events where incident_id = $1 order by id", [r.id])).rows.map((e) => e.action);
      expect(events).toEqual(["reported", "photo added", "investigation saved", "witness added", "action added", "action done", "closed"]);
      // A closed incident takes no new photos from the reporter.
      await s.as(driverUser);
      expect((await pgError(s.query("select public.safety_photo_begin($1, 'image/jpeg', 2000)", [r.id]))).message).toMatch(/not found/);

      // Numbers run in order within the company.
      await s.as(owner);
      const second = (await s.query<{ r: { number: string } }>("select public.safety_report($1::jsonb) r", [JSON.stringify({ kind: "near_miss", occurred_at: now, description: "Loader reversed close" })])).rows[0].r;
      expect(Number(second.number.slice(4))).toBe(Number(r.number.slice(4)) + 1);

      // Another company sees nothing and cannot act on it.
      const other = await s.createCompany("Other Safety Co (test)");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select id from public.safety_incidents where id = $1", [r.id])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.safety_investigate($1, '{}'::jsonb)", [r.id]))).message).toMatch(/not found/);
      expect((await s.query<{ r: string | null }>("select public.safety_photo_path(id) r from (select $1::uuid id) x", [r.id])).rows[0].r).toBeNull();
    });
  });

  it("adds demo samples only to a demo company, once", async () => {
    await withSession(async (s) => {
      const owner = await s.createUser("owner");
      await s.as(owner);
      expect((await pgError(s.query("select public.demo_safety_samples()"))).message).toMatch(/only added to a demo company/);
    });
  });
});
