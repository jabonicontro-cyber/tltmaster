import { describe, expect, it } from "vitest";
import { acceptTriage, higherUrgency, triageChanges, triageRules, URGENCY_RANK, type TriageCurrent } from "@/lib/maintenance-triage";
import { WO_URGENCIES, type WoUrgency } from "@/lib/maintenance";

// Safety (B3, mechanic walkthrough 2026-11-09): a triage suggestion never lowers a job's urgency and never removes or
// overrides the safety-critical flag. Accepting keeps the higher of the current and the suggested urgency.

const URGENCIES = Object.keys(WO_URGENCIES) as WoUrgency[];
const base = { openOnUnit: [] as Array<{ id: string; number: string; title: string; category: string }> };

describe("accepting a triage suggestion never lowers anything", () => {
  it("keeps the higher urgency for every pair of current and suggested urgency, and never drops the safety flag", () => {
    for (const cur of URGENCIES) for (const sug of URGENCIES) for (const curSafe of [true, false]) for (const sugSafe of [true, false]) {
      const out = acceptTriage({ category: "repair", urgency: cur, safetyCritical: curSafe }, { category: "tires", urgency: sug, safetyReview: sugSafe });
      expect(URGENCY_RANK[out.next.urgency]).toBeGreaterThanOrEqual(URGENCY_RANK[cur]);
      expect(out.next.urgency).toBe(higherUrgency(cur, sug));
      expect(out.lowersUrgency).toBe(false);
      if (curSafe) expect(out.next.safetyCritical).toBe(true);
      expect(out.next.safetyCritical).toBe(curSafe || sugSafe);
    }
  });

  it("an Immediate safety-critical job stays Immediate and safety-critical when the suggestion says Normal", () => {
    const current: TriageCurrent = { category: "tires", urgency: "immediate", safetyCritical: true };
    const out = acceptTriage(current, { category: "tires", urgency: "normal", safetyReview: false });
    expect(out.next).toEqual({ category: "tires", urgency: "immediate", safetyCritical: true });
    expect(out.changes).toEqual([]); // nothing changes, so nothing to confirm
    expect(out.kept).toContain("Urgency stays Immediate (the suggestion said Normal; the higher one is kept).");
    expect(out.kept).toContain("It stays safety-critical: only an authorized inspection clears it.");
  });

  it("says exactly what accepting changes, so the person confirms it", () => {
    const out = acceptTriage({ category: "repair", urgency: "normal", safetyCritical: false }, { category: "brakes", urgency: "high", safetyReview: true });
    expect(out.changes).toEqual([
      "Category: Repair → Brakes",
      "Urgency: Normal → High",
      "Marks it safety-critical: the vehicle stays out of service until an authorized inspection clears it.",
    ]);
  });

  it("a person's own edit may lower the urgency, and it is said plainly; the safety flag still stays", () => {
    const out = triageChanges({ category: "tires", urgency: "immediate", safetyCritical: true }, { category: "tires", urgency: "normal", safetyCritical: false });
    expect(out.lowersUrgency).toBe(true);
    expect(out.changes).toEqual(["Urgency: Immediate → Normal (lower)"]);
    expect(out.next.safetyCritical).toBe(true);
  });
});

describe("the suggestion itself starts from the work order", () => {
  it("never suggests below the current urgency or without the current safety flag", () => {
    for (const urgency of URGENCIES) for (const safetyCritical of [true, false]) {
      const r = triageRules({ ...base, title: "Mirror loose", description: "Passenger mirror is loose.", current: { urgency, safetyCritical } });
      expect(URGENCY_RANK[r.urgency]).toBeGreaterThanOrEqual(URGENCY_RANK[urgency]);
      if (safetyCritical) expect(r.safetyReview).toBe(true);
    }
  });

  it("the walkthrough's tire report keeps High and safety-critical", () => {
    const r = triageRules({ ...base, title: "Pre-trip defect", description: "tires: Front left tire low, sidewall cut", current: { urgency: "high", safetyCritical: true } });
    expect(r).toMatchObject({ category: "tires", urgency: "high", safetyReview: true });
  });
});

describe("tire damage counts as safety-critical", () => {
  const safety = (description: string) => triageRules({ ...base, title: "Driver report", description }).safetyReview;
  it.each([
    "Sidewall cut on the left steer tire",
    "Bulge on the right rear tire",
    "Low tire on the trailer, front axle",
    "Front left tire low",
    "Flat on the drive axle",
    "Blowout on the highway",
    "Tread separation on the trailer tire",
    "Deep cut in the tire",
    "Brakes feel soft", // already there
    "Steering pulls hard left", // already there
    "No brake lights", // already there
  ])("%s", (text) => expect(safety(text)).toBe(true));

  it.each([
    "Engine cuts out at idle",
    "Flatbed strap is frayed",
    "Mirror loose",
  ])("not on its own: %s", (text) => expect(safety(text)).toBe(false));
});
