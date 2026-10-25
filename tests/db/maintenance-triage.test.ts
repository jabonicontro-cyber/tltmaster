import { afterAll, describe, expect, it } from "vitest";
import { insert } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// Maintenance request triage (20261120003100): suggestions are stored with their source; a person accepts, edits or
// rejects; accepting can add the safety-critical flag (restricting the truck) but nothing here can remove it.

const tag = () => Math.random().toString(36).slice(2, 7);
const suggestion = (over: Record<string, unknown> = {}) => ({
  version: 1, problem: "Air leak", facts: ["Hissing near the rear chamber."], symptoms: ["hissing"], onset: null, worsening: "unknown",
  questions: ["When did it start?"], category: "brakes", urgency: "high", safetyReview: true, reasons: [], related: [], ...over,
});

async function setup(s: Session) {
  const owner = await s.createUser("owner");
  const mech = await s.createUser("mechanic");
  await s.as(owner);
  const truck = await insert(s, "trucks", { unit_number: `TR-${tag()}`, truck_type: "tri_axle_dump" });
  await s.as(mech);
  const wo = (await s.query<{ r: { id: string } }>("select public.maintenance_create_work_order($1::jsonb) r",
    [JSON.stringify({ truck_id: truck, title: "Air leak", description: "Hissing near the rear chamber.", category: "repair", urgency: "normal" })])).rows[0].r.id;
  return { owner, mech, truck, wo };
}
const save = (s: Session, wo: string, sug: object, source = "rules") =>
  s.query<{ id: string }>("select public.maintenance_save_triage($1, $2, '', $3::jsonb) id", [wo, source, JSON.stringify(sug)]).then((r) => r.rows[0].id);
const woRow = async (s: Session, id: string) => (await s.query("select category, urgency, safety_critical, title, description from public.work_orders where id = $1", [id])).rows[0];

describe("maintenance triage", () => {
  it("accepting applies the suggestion and a safety review restricts the truck; the report itself is unchanged", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const id = await save(s, w.wo, suggestion());
      await s.query("select public.maintenance_decide_triage($1, 'accepted')", [id]);
      expect(await woRow(s, w.wo)).toMatchObject({ category: "brakes", urgency: "high", safety_critical: true, title: "Air leak", description: "Hissing near the rear chamber." });
      await s.asAdmin();
      expect((await s.query<{ v: string }>("select service_status::text v from public.trucks where id = $1", [w.truck])).rows[0].v).toBe("out_of_service");
      await s.as(w.mech);
      expect((await pgError(s.query("select public.maintenance_decide_triage($1, 'rejected', null, null, null, 'changed mind')", [id]))).message).toMatch(/already accepted/);
      const events = (await s.query<{ note: string }>("select note from public.work_order_events where work_order_id = $1 and kind = 'triage' order by created_at", [w.wo])).rows.map((r) => r.note);
      expect(events).toEqual(["Triage suggested by rules (not yet reviewed)", "Triage accepted"]);
    });
  });

  it("an edit can never remove a safety flag, and a rejection needs a reason", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.query("select public.maintenance_decide_triage($1, 'accepted')", [await save(s, w.wo, suggestion())]);
      // A later suggestion edited to "not safety-related" leaves the safety flag in place.
      const second = await save(s, w.wo, suggestion({ safetyReview: false, urgency: "low" }));
      await s.query("select public.maintenance_decide_triage($1, 'edited', 'body', 'low', false, 'Only a mirror')", [second]);
      expect(await woRow(s, w.wo)).toMatchObject({ category: "body", urgency: "low", safety_critical: true });

      const third = await save(s, w.wo, suggestion());
      expect((await pgError(s.query("select public.maintenance_decide_triage($1, 'rejected')", [third]))).message).toMatch(/why/);
      await s.query("select public.maintenance_decide_triage($1, 'rejected', null, null, null, 'Duplicate of the first report')", [third]);
      expect((await s.query("select status from public.work_order_triage where id = $1", [third])).rows[0].status).toBe("rejected");
    });
  });

  it("a new suggestion supersedes the open one; bad suggestions, drivers and other companies are refused", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const first = await save(s, w.wo, suggestion());
      await save(s, w.wo, suggestion({ category: "tires" }), "ai");
      expect((await s.query("select status from public.work_order_triage where id = $1", [first])).rows[0].status).toBe("superseded");
      expect((await pgError(save(s, w.wo, { category: "brakes" }))).message).toMatch(/incomplete/);
      expect((await pgError(save(s, w.wo, suggestion({ category: "rocket" })))).message).toMatch(/incomplete/);

      const driver = await s.createUser("driver");
      await s.as(driver);
      expect((await pgError(save(s, w.wo, suggestion()))).code).toBe("42501");
      expect((await s.query("select 1 from public.work_order_triage where work_order_id = $1", [w.wo])).rowCount).toBe(0);

      const other = await s.createCompany(`Other ${tag()}`);
      const outsider = await s.createUser("owner", { companyId: other });
      await s.asAdmin();
      await s.query("update public.profiles set active_company_id = $1 where id = $2", [other, outsider]);
      await s.as(outsider);
      expect((await s.query("select 1 from public.work_order_triage where work_order_id = $1", [w.wo])).rowCount).toBe(0);
      expect((await pgError(s.query("select public.maintenance_decide_triage($1, 'accepted')", [first]))).code).toBe("P0002");
    });
  });
});
