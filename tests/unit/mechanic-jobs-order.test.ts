import { describe, expect, it } from "vitest";
import { compareMechanicJobs, COMPLETED_VS_CLOSED, currentRestrictionReason, fixedFromNotes, startJobMessage } from "@/lib/maintenance";
import { signInHome } from "@/lib/companion";
import { freeDayGroups } from "@/lib/maintenance/insights";

// Mechanic round 2 (walkthrough 2026-11-09): the order jobs are listed in (B2), one start rule (I1), no double entry
// (I8), the truck's current reason (I3), free days said once, and a mechanic's home after sign-in.

const j = (number: string, safetyCritical: boolean, urgency: string, createdAt: string) => ({ number, safetyCritical, urgency, createdAt });

describe("mechanic job order (B2)", () => {
  it("safety-critical first, then Immediate, High, Normal, Low, then the oldest", () => {
    const jobs = [
      j("MWO-1", false, "low", "2026-11-01T08:00:00Z"),
      j("MWO-2", false, "immediate", "2026-11-09T08:00:00Z"),
      j("MWO-3", true, "normal", "2026-11-09T09:00:00Z"),
      j("MWO-4", false, "high", "2026-11-05T08:00:00Z"),
      j("MWO-5", true, "immediate", "2026-11-09T10:00:00Z"),
      j("MWO-6", false, "normal", "2026-11-02T08:00:00Z"),
      j("MWO-7", false, "normal", "2026-11-01T08:00:00Z"),
      j("MWO-8", true, "immediate", "2026-11-08T10:00:00Z"),
    ];
    expect([...jobs].sort(compareMechanicJobs).map((x) => x.number)).toEqual(["MWO-8", "MWO-5", "MWO-3", "MWO-2", "MWO-4", "MWO-7", "MWO-6", "MWO-1"]);
  });
  it("an unknown urgency goes after Low", () => {
    expect([j("A", false, "?", "2026-01-01"), j("B", false, "low", "2026-02-01")].sort(compareMechanicJobs).map((x) => x.number)).toEqual(["B", "A"]);
  });
});

describe("one start rule (I1)", () => {
  it("says who leads and whether the timer runs", () => {
    expect(startJobMessage({ lead: "set", timerError: null })).toBe("Job started. You are the lead mechanic. Your timer is running.");
    expect(startJobMessage({ lead: "kept", timerError: null })).toBe("Job started. Your timer is running.");
    expect(startJobMessage({ lead: "kept", timerError: "Your timer is already running on MWO-1. Stop it first." }))
      .toBe("Job started. Your timer did not start: Your timer is already running on MWO-1. Stop it first.");
    expect(startJobMessage({ lead: "failed", timerError: null })).toBe("Job started. Nobody leads it yet: assign a lead on the Labor tab. Your timer is running.");
  });
});

describe("no double entry (I8)", () => {
  it("starts What did you fix? from the timer notes, each once, oldest first", () => {
    expect(fixedFromNotes(["Cut sidewall, left steer tire", " ", null, "cut sidewall, left steer tire", "Mounted the new tire"])).toBe("Cut sidewall, left steer tire\nMounted the new tire");
    expect(fixedFromNotes([])).toBe("");
  });
  it("explains Completed and Closed in plain words", () => {
    expect(COMPLETED_VS_CLOSED).toMatch(/^Completed means the repair is done\. Closed means/);
  });
});

describe("the truck's current reason (I3)", () => {
  const stored = "Safety-critical defect, work order MWO-1023: Pre-trip inspection defect: truck 103";
  it("names the remaining work order once the one in the stored reason is cleared", () => {
    expect(currentRestrictionReason(stored, [{ number: "MWO-1024", title: "Air hissing near rear axle" }])).toBe("Safety-critical defect, work order MWO-1024: Air hissing near rear axle");
    expect(currentRestrictionReason(stored, [{ number: "MWO-1024", title: "A" }, { number: "MWO-1030", title: "B" }])).toBe("Safety-critical defects, work orders MWO-1024, MWO-1030");
  });
  it("keeps a reason that is still right, a reason typed by a person, and the stored one when nothing open is known", () => {
    expect(currentRestrictionReason(stored, [{ number: "MWO-1023", title: "Pre-trip inspection defect: truck 103" }])).toBe(stored);
    expect(currentRestrictionReason("Accident damage, waiting for the insurer", [{ number: "MWO-1024", title: "A" }])).toBe("Accident damage, waiting for the insurer");
    expect(currentRestrictionReason(stored, [])).toBe(stored);
    // The older wording with a long dash is read the same way.
    expect(currentRestrictionReason("Safety-critical defect — work order MWO-1023: X", [{ number: "MWO-1024", title: "Y" }])).toBe("Safety-critical defect, work order MWO-1024: Y");
  });
});

describe("shop insights free days are said once", () => {
  it("groups jobs whose trucks share the same free days and names each truck once", () => {
    const days = ["2026-11-10", "2026-11-11", "2026-11-12"];
    expect(freeDayGroups([
      { unitLabel: "Truck 103", freeDays: days },
      { unitLabel: "Truck 103", freeDays: days },
      { unitLabel: "Truck 104", freeDays: days },
      { unitLabel: "Trailer B-31", freeDays: null },
      { unitLabel: "Truck 105", freeDays: ["2026-11-12"] },
    ])).toEqual([{ days, units: ["Truck 103", "Truck 104"] }, { days: ["2026-11-12"], units: ["Truck 105"] }]);
  });
});

describe("home after sign-in", () => {
  it("is My jobs for a mechanic-only login and unchanged for everyone else", () => {
    expect(signInHome(["maintenance.view", "maintenance.manage"])).toBe("/maintenance/my-jobs");
    expect(signInHome(["maintenance.view", "dispatch.view"])).toBeNull();
    expect(signInHome(["driver.portal"])).toBeNull();
    expect(signInHome(["maintenance.view", "fleet.view", "billing.view", "dispatch.view", "orders.view"])).toBeNull();
  });
});
