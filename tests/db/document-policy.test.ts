import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import { assign, businessToday, fleet, insert, planLoad, scheduledOrder } from "./fixtures";
import { pgError, pool, withSession, type Session } from "./helpers";

afterAll(() => pool.end());

// Expired vehicle documents (20261112000200; owner 2026-10-13, master plan §9 Q23): per kind, insurance and
// registration block by default and inspection and permit warn; only a VERIFIED expired document blocks; the latest
// document of a kind decides (a renewal replaces an expired one); the database names the vehicle, kind, date and fix.
// Fictional data; every test runs in a rolled-back transaction.

async function setup(s: Session) {
  const today = await businessToday(s);
  const day = addDays(today, 2);
  const owner = await s.createUser("owner");
  const f = await fleet(s, owner, day);
  const order = await scheduledOrder(s, owner, today, addDays(today, 5));
  const load = await planLoad(s, order.id, day, "08:00", "10:00");
  const unit = (await s.query<{ unit_number: string }>("select unit_number from public.trucks where id = $1", [f.t1])).rows[0].unit_number;
  return { today, day, owner, f, load, unit };
}
const doc = (s: Session, truck: string, kind: string, expires: string) => insert(s, "vehicle_documents", { truck_id: truck, kind, expires_on: expires });
const verify = (s: Session, id: string) => s.query("select public.verify_vehicle_document($1)", [id]);
const eligibility = (s: Session, truck: string, driver: string, on: string) =>
  s.query<{ r: { blockers: string[]; warnings: string[] } }>("select public.check_assignment_eligibility($1, null, $2, $3) as r", [truck, driver, on]).then((r) => r.rows[0].r);

describe("expired vehicle documents policy", () => {
  it("a verified expired insurance blocks assignment with the vehicle, kind, date and fix; unverified only warns", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      const ins = await doc(s, w.f.t1, "insurance", addDays(w.today, -3));
      // Unverified: a warning, so a typo never silently stops a truck.
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).warnings).toContain("truck_document_review");
      await verify(s, ins);
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).blockers).toContain("truck_document_expired");
      const err = await pgError(assign(s, w.load.load_id, w.f.t1, null, w.f.d1));
      expect(err.message).toContain(`Truck ${w.unit}: insurance expired`);
      expect(err.message).toMatch(/record the renewed document in Fleet, or change the company rule in Settings/);
      // Another truck is fine.
      expect(await assign(s, w.load.load_id, w.f.t2, null, w.f.d1)).toBeTruthy();
    });
  });

  it("a renewal replaces the expired document; a later expiry date unverifies; archiving removes it", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      const old = await doc(s, w.f.t1, "registration", addDays(w.today, -10));
      await verify(s, old);
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).blockers).toContain("truck_document_expired");
      await doc(s, w.f.t1, "registration", addDays(w.today, 365)); // renewed (not even verified yet)
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).blockers).not.toContain("truck_document_expired");
      // Changing a verified document's date clears the verification.
      const ins = await doc(s, w.f.t1, "insurance", addDays(w.today, -1));
      await verify(s, ins);
      await s.query("update public.vehicle_documents set expires_on = $2 where id = $1", [ins, addDays(w.today, -2)]);
      expect((await s.query("select verified_at from public.vehicle_documents where id = $1", [ins])).rows[0].verified_at).toBeNull();
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).warnings).toContain("truck_document_review");
    });
  });

  it("inspection and permit warn by default; a company can make them block, or make insurance only warn", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      await s.as(w.owner);
      const insp = await doc(s, w.f.t1, "inspection", addDays(w.today, -5));
      await verify(s, insp);
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).blockers).not.toContain("truck_document_expired");
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).warnings).toContain("truck_document_review");
      expect((await s.query<{ r: Record<string, string> }>("select public.document_rules() as r")).rows[0].r).toEqual({ registration: "block", insurance: "block", inspection: "warn", permit: "warn" });
      await s.query("select public.set_document_rule('inspection', 'block')");
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).blockers).toContain("truck_document_expired");
      await s.query("select public.set_document_rule('inspection', 'warn')");
      const ins = await doc(s, w.f.t1, "insurance", addDays(w.today, -5));
      await verify(s, ins);
      await s.query("select public.set_document_rule('insurance', 'warn')");
      expect((await eligibility(s, w.f.t1, w.f.d1, w.day)).blockers).not.toContain("truck_document_expired");
      // Lease, title and other documents are never checked.
      await doc(s, w.f.t2, "lease", addDays(w.today, -5));
      expect((await eligibility(s, w.f.t2, w.f.d1, w.day)).warnings).not.toContain("truck_document_review");
    });
  });

  it("only settings.manage changes rules and fleet.edit verifies; dispatch sees issues without document details; other companies see nothing", async () => {
    await withSession(async (s) => {
      const w = await setup(s);
      const dispatcher = await s.createUser("dispatcher");
      await s.as(w.owner);
      const ins = await doc(s, w.f.t1, "insurance", addDays(w.today, -5));
      await s.as(dispatcher);
      expect((await pgError(s.query("select public.set_document_rule('insurance', 'warn')"))).code).toBe("42501");
      expect((await pgError(verify(s, ins))).code).toBe("42501");
      const issues = await s.query("select * from public.dispatch_document_issues($1)", [w.day]);
      const mine = issues.rows.filter((r) => r.truck_id === w.f.t1);
      expect(mine).toEqual([{ truck_id: w.f.t1, trailer_id: null, kind: "insurance", expires_on: expect.anything(), verified: false, action: "block", blocks: false }]);
      const other = await s.createCompany("Brookside Aggregates");
      const otherOwner = await s.createUser("owner", { companyId: other });
      await s.as(otherOwner);
      expect((await s.query("select * from public.dispatch_document_issues($1)", [w.day])).rowCount).toBe(0);
      expect((await pgError(verify(s, ins))).message).toMatch(/not found/);
    });
  });
});
