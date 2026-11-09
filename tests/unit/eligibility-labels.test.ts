import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { driverDayChecks, vehicleDayChecks, type DayRestrictions } from "@/lib/dispatch/board";
import { ASSIGNMENT_WARNING_MESSAGES, ELIGIBILITY_MESSAGES, eligibilityMessage, evaluateAssignment, type QualificationState } from "@/lib/fleet/eligibility";

// Every blocker or warning code the eligibility engine can emit (the database's private.assignment_eligibility and
// assign_load, and the board's own pre-checks) must have a label, so no raw code such as trailer_document_review
// reaches the screen (B2).

const dir = path.join(process.cwd(), "supabase/migrations");
const migrations = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(path.join(dir, f), "utf8"));

/** Codes the database appends to blockers or warnings in any migration, plus the qualification codes it builds. */
function databaseCodes(): string[] {
  const codes = new Set<string>(["trailer_required", "driver_off_shift"]);
  for (const sql of migrations) {
    for (const m of sql.matchAll(/v_(?:blockers|warnings)\s*:=\s*v_(?:blockers|warnings)\s*\|\|\s*'([a-z_]+)'::text/g)) codes.add(m[1]);
  }
  const states: QualificationState[] = ["missing", "class_insufficient", "expired", "expiry_unknown", "unverified"];
  for (const s of states) {
    codes.add(`cdl_${s}`);
    codes.add(`medical_card_${s}`);
  }
  return [...codes].sort();
}

/** Codes the board's own checks produce, from inputs that trigger each rule. */
function boardCodes(): string[] {
  const codes = new Set<string>();
  const add = (r: { blockers: string[]; warnings: string[] }) => [...r.blockers, ...r.warnings].forEach((c) => codes.add(c));
  const on = "2026-11-09";
  const truck = { active: false, service_status: "out_of_service" as const, truck_type: "tractor" as const, weight_capacity: null, volume_capacity: null, capacity_verified_at: null };
  const trailer = { active: false, service_status: "out_of_service" as const, compatible_truck_types: [], weight_capacity: 10, volume_capacity: null, capacity_verified_at: null };
  add(evaluateAssignment({ truck, trailer: { ...trailer, compatible_truck_types: ["tri_axle_dump" as const] }, driver: { active: false, qualifications: [] } }, on));
  add(evaluateAssignment({ truck: { ...truck, weight_capacity: 10 }, trailer: { ...trailer, weight_capacity: null } }, on));
  const r = (over: Partial<DayRestrictions>): DayRestrictions => ({ shop: [], reports: [], documents: [], timeOff: [], shifts: [], ...over });
  for (const kind of ["truck", "trailer"] as const) {
    const ids = { truck_id: kind === "truck" ? "V" : null, trailer_id: kind === "trailer" ? "V" : null };
    add(vehicleDayChecks(kind, "V", on, r({ shop: [{ ...ids, number: "W1", status: "scheduled", scheduled_for: on, safety_critical: true }], reports: [{ ...ids, equipment: kind, kind: "breakdown" }], documents: [{ ...ids, blocks: true }] })));
    add(vehicleDayChecks(kind, "V", on, r({ shop: [{ ...ids, number: "W2", status: "in_progress", scheduled_for: null, safety_critical: false }], reports: [{ ...ids, equipment: kind, kind: "equipment_issue" }], documents: [{ ...ids, blocks: false }] })));
  }
  add(driverDayChecks("D", on, r({ timeOff: [{ driver_id: "D", status: "approved", full_day: true, start_date: on, end_date: on }, { driver_id: "D", status: "pending", full_day: true, start_date: on, end_date: on }] })));
  add(driverDayChecks("D", on, r({ timeOff: [{ driver_id: "D", status: "approved", full_day: false, start_date: on, end_date: on }] })));
  return [...codes].sort();
}

/** The latest private.eligibility_message: code → text. */
function databaseMessages(): Map<string, string> {
  const latest = migrations.filter((sql) => /FUNCTION private\.eligibility_message/i.test(sql)).at(-1)!;
  const body = latest.slice(latest.search(/FUNCTION private\.eligibility_message/i));
  const out = new Map<string, string>();
  for (const m of body.slice(0, body.indexOf("else p_code")).matchAll(/when '([a-z_]+)' then '((?:[^']|'')*)'/g)) out.set(m[1], m[2].replace(/''/g, "'"));
  return out;
}

describe("eligibility labels (B2)", () => {
  it("finds the codes it checks", () => {
    expect(databaseCodes()).toEqual(expect.arrayContaining(["truck_document_review", "trailer_document_review", "truck_shop_work_open", "driver_time_off"]));
    expect(boardCodes()).toEqual(expect.arrayContaining(["trailer_capacity_unknown", "truck_capacity_unverified", "trailer_incompatible", "trailer_compatibility_unknown", "trailer_document_expired", "driver_partial_time_off"]));
  });

  it("every code the database or the board can emit has a label", () => {
    const missing = [...new Set([...databaseCodes(), ...boardCodes()])].filter((c) => eligibilityMessage(c) === c);
    expect(missing).toEqual([]);
  });

  it("labels say the same as the database's own messages", () => {
    const db = databaseMessages();
    expect(db.size).toBeGreaterThan(30);
    for (const [code, text] of db) expect({ code, text: ELIGIBILITY_MESSAGES[code] }).toEqual({ code, text });
    expect(ASSIGNMENT_WARNING_MESSAGES.driver_off_shift).toBeTruthy();
  });
});
