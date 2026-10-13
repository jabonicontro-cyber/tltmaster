import { describe, expect, it } from "vitest";
import { assessReadiness, type ReadinessCounts } from "@/lib/onboarding/readiness";

// Company setup readiness (docs/ONBOARDING.md): missing or incomplete data is named, never treated as fine.

const complete: ReadinessCounts = {
  company: { name: "Ridgeway Aggregates (test)", timezone: "America/Chicago", addressComplete: true, contactComplete: true, hasLogo: true },
  users: { active: 4, roles: ["owner", "dispatcher", "office", "driver"] },
  customers: { active: 12, withoutBillingAddress: 0, withoutEmail: 0 },
  materials: { active: 8, withoutStandardRate: 0 },
  trucks: { active: 6, capacityUnknown: 0, capacityUnverified: 0, outOfService: 1 },
  trailers: null,
  tractors: 0,
  drivers: { active: 5, withoutValidCdl: 0, withoutValidMedical: 0, unverified: 0, withoutLogin: 2 },
};

describe("company setup readiness", () => {
  it("a complete company is ready, with what was found summarised", () => {
    const r = assessReadiness(complete);
    expect(r.items.every((i) => i.status === "done")).toBe(true);
    expect(r).toMatchObject({ done: 6, total: 6 });
    expect(r.items.find((i) => i.id === "trucks")?.detail).toBe("6 trucks · 1 out of service.");
    expect(r.items.find((i) => i.id === "drivers")?.detail).toMatch(/2 without a login/);
  });

  it("a new company sees what is missing, never a false all-clear", () => {
    const r = assessReadiness({
      ...complete,
      company: { name: "New Co", timezone: "", addressComplete: false, contactComplete: false, hasLogo: false },
      users: { active: 1, roles: ["owner"] },
      customers: { active: 0, withoutBillingAddress: 0, withoutEmail: 0 },
      materials: { active: 0, withoutStandardRate: 0 },
      trucks: { active: 0, capacityUnknown: 0, capacityUnverified: 0, outOfService: 0 },
      drivers: { active: 0, withoutValidCdl: 0, withoutValidMedical: 0, unverified: 0, withoutLogin: 0 },
    });
    expect(r.done).toBe(0);
    expect(r.items.find((i) => i.id === "company")).toMatchObject({ status: "incomplete", detail: "Missing: address, phone or email, time zone." });
    expect(r.items.filter((i) => i.status === "missing").map((i) => i.id)).toEqual(["users", "customers", "materials", "trucks", "drivers"]);
  });

  it("incomplete records are counted by problem", () => {
    const r = assessReadiness({
      ...complete,
      materials: { active: 8, withoutStandardRate: 3 },
      trucks: { active: 6, capacityUnknown: 1, capacityUnverified: 2, outOfService: 0 },
      drivers: { active: 5, withoutValidCdl: 1, withoutValidMedical: 0, unverified: 2, withoutLogin: 0 },
    });
    expect(r.items.find((i) => i.id === "materials")).toMatchObject({ status: "incomplete", detail: "8 materials · 3 without a standard rate." });
    expect(r.items.find((i) => i.id === "trucks")?.detail).toBe("6 trucks · 1 without a recorded capacity · 2 with unverified capacity.");
    expect(r.items.find((i) => i.id === "drivers")?.detail).toBe("5 drivers · 1 without a valid CDL · 2 with unverified qualifications.");
  });

  it("tractors without trailers are called out; trailers appear only for fleets that use them", () => {
    expect(assessReadiness(complete).items.some((i) => i.id === "trailers")).toBe(false);
    const r = assessReadiness({ ...complete, tractors: 10, trailers: { active: 0, capacityUnknown: 0, compatibilityUnknown: 0 } });
    expect(r.items.find((i) => i.id === "trailers")).toMatchObject({ status: "missing", detail: "10 tractors but no trailers: a tractor can only be dispatched with a trailer." });
  });
});
