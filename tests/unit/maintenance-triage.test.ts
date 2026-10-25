import { describe, expect, it } from "vitest";
import { triageRules } from "@/lib/maintenance-triage";

const base = { openOnUnit: [] as Array<{ id: string; number: string; title: string; category: string }> };

describe("maintenance request triage (rules)", () => {
  it("flags a brake air leak for safety review, quotes the report and asks what is missing", () => {
    const r = triageRules({ ...base, title: "Air leak at rear axle", description: "Hissing near the rear brake chamber since this morning. It is getting worse. Truck is parked in the yard." });
    expect(r).toMatchObject({ category: "brakes", safetyReview: true, urgency: "high", worsening: "yes", onset: "since this morning" });
    expect(r.facts).toEqual(["Hissing near the rear brake chamber since this morning.", "It is getting worse.", "Truck is parked in the yard."]);
    expect(r.questions).toContain("What does the air pressure gauge show, and does it drop when the brakes are applied?");
    expect(r.questions).not.toContain("When did it start?");
  });

  it("calls a vehicle that cannot run immediate", () => {
    const r = triageRules({ ...base, title: "Won't start", description: "Truck won't start at the quarry, driver stranded." });
    expect(r.urgency).toBe("immediate");
    expect(r.category).toBe("repair"); // a no-start has many causes: no system is guessed
  });

  it("invents nothing when the report is thin: unknowns stay unknown and become questions", () => {
    const r = triageRules({ ...base, title: "Something off", description: "Feels weird." });
    expect(r).toMatchObject({ category: "repair", safetyReview: false, urgency: "normal", onset: null, worsening: "unknown", symptoms: [] });
    expect(r.questions).toEqual(expect.arrayContaining(["When did it start?", "Is it getting worse, or the same as when it started?", "What exactly happens: a noise, a warning light, a leak, a vibration?"]));
  });

  it("points at open work orders on the same unit in the same system", () => {
    const r = triageRules({ title: "Brakes soft", description: "Soft pedal.", openOnUnit: [
      { id: "1", number: "MWO-1", title: "Brake chamber", category: "brakes" },
      { id: "2", number: "MWO-2", title: "Mirror", category: "body" },
    ] });
    expect(r.related.map((x) => x.number)).toEqual(["MWO-1"]);
  });

  it("does not take 'not getting worse' as worsening", () => {
    expect(triageRules({ ...base, title: "Oil leak", description: "Small oil leak, not getting worse." }).worsening).toBe("no");
  });
});
