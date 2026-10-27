import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_RULES, parseRules, truckHealth, type TruckFacts } from "@/lib/fleet/health";

// Truck health (B93): safety facts are always At risk; the company's rules decide the rest; every level says why.
const f = (over: Partial<TruckFacts> = {}): TruckFacts => ({ outOfService: false, openSafety: 0, openOther: 0, repairs90: 0, serviceOverdue: 0, ...over });

describe("truck health", () => {
  it("is Good with nothing recorded", () => {
    expect(truckHealth(f(), DEFAULT_HEALTH_RULES)).toEqual({ level: "good", reasons: [] });
  });

  it("is always At risk with a safety defect or out of service, even with every rule off", () => {
    const off = { at_risk_repairs: 0, watch_repairs: 0, watch_open: 0, service_overdue: "off" as const };
    expect(truckHealth(f({ openSafety: 1 }), off)).toEqual({ level: "at_risk", reasons: ["1 open safety-critical defect"] });
    expect(truckHealth(f({ outOfService: true }), off).level).toBe("at_risk");
  });

  it("follows the default rules for repairs, open work and overdue service", () => {
    expect(truckHealth(f({ repairs90: 1 }), DEFAULT_HEALTH_RULES)).toEqual({ level: "watch", reasons: ["1 unplanned repair in 90 days"] });
    expect(truckHealth(f({ repairs90: 2 }), DEFAULT_HEALTH_RULES)).toEqual({ level: "at_risk", reasons: ["2 unplanned repairs in 90 days"] });
    expect(truckHealth(f({ serviceOverdue: 1, openOther: 2 }), DEFAULT_HEALTH_RULES)).toEqual({ level: "watch", reasons: ["1 service overdue", "2 open repairs"] });
    expect(truckHealth(f({ openOther: 1 }), DEFAULT_HEALTH_RULES).level).toBe("good");
  });

  it("uses the company's own rules", () => {
    const strict = { ...DEFAULT_HEALTH_RULES, service_overdue: "at_risk" as const, at_risk_repairs: 0 };
    expect(truckHealth(f({ serviceOverdue: 2, repairs90: 5 }), strict)).toEqual({ level: "at_risk", reasons: ["2 services overdue", "5 unplanned repairs in 90 days"] });
  });

  it("reads stored rules safely", () => {
    expect(parseRules(null)).toEqual(DEFAULT_HEALTH_RULES);
    expect(parseRules({ at_risk_repairs: "3", watch_repairs: -1, service_overdue: "nope" })).toEqual({ ...DEFAULT_HEALTH_RULES, at_risk_repairs: 3 });
  });
});
