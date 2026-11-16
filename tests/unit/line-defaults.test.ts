// Default units for new lines (master plan MK1): the company's own catalog first, then what it hauls, always among its
// own active units; never a rate.
import { describe, expect, it } from "vitest";
import { defaultLineUnit } from "@/lib/line-defaults";

const ALL = ["ton", "load", "cu_yd", "hour", "mile", "day", "each"].map((code) => ({ code, active: true }));
const FREIGHT_UNITS = ALL.map((u) => ({ ...u, active: !["ton", "cu_yd"].includes(u.code) }));

describe("default unit for a new line", () => {
  it("follows what the company hauls when its catalog says nothing", () => {
    expect(defaultLineUnit({ kind: "hauling", industry: "aggregate", units: ALL })).toBe("ton");
    expect(defaultLineUnit({ kind: "hauling", industry: "freight", units: FREIGHT_UNITS })).toBe("mile");
    expect(defaultLineUnit({ kind: "hauling", industry: "both", units: ALL })).toBe("ton");
    expect(defaultLineUnit({ kind: "material", industry: "aggregate", units: ALL })).toBe("ton");
    expect(defaultLineUnit({ kind: "material", industry: "freight", units: FREIGHT_UNITS })).toBe("load");
    // Unknown or missing industry is aggregate (every company before the setting).
    expect(defaultLineUnit({ kind: "hauling", industry: undefined, units: ALL })).toBe("ton");
  });

  it("prefers the company's own catalog: the unit most of its active items of that kind use", () => {
    const charges = [
      { default_unit_code: "load", kind: "hauling", calc_method: "per_unit", active: true },
      { default_unit_code: "load", kind: "hauling", calc_method: "per_unit", active: true },
      { default_unit_code: "ton", kind: "hauling", calc_method: "per_unit", active: true },
      // Not counted: inactive, not hauling, or a percentage.
      { default_unit_code: "hour", kind: "hauling", calc_method: "per_unit", active: false },
      { default_unit_code: "hour", kind: "surcharge", calc_method: "per_unit", active: true },
      { default_unit_code: null, kind: "hauling", calc_method: "percent_of_subtotal", active: true },
    ];
    expect(defaultLineUnit({ kind: "hauling", industry: "aggregate", units: ALL, charges })).toBe("load");
    const materials = [{ default_unit_code: "cu_yd", active: true }, { default_unit_code: "cu_yd", active: true }, { default_unit_code: "ton", active: true }];
    expect(defaultLineUnit({ kind: "material", industry: "aggregate", units: ALL, materials })).toBe("cu_yd");
    // A tie (one per-load and one per-ton hauling charge) goes to what the company hauls.
    const tie = [{ default_unit_code: "load", kind: "hauling", calc_method: "per_unit" }, { default_unit_code: "ton", kind: "hauling", calc_method: "per_unit" }];
    expect(defaultLineUnit({ kind: "hauling", industry: "aggregate", units: ALL, charges: tie })).toBe("ton");
    expect(defaultLineUnit({ kind: "hauling", industry: "freight", units: ALL, charges: [...tie, { default_unit_code: "mile", kind: "hauling", calc_method: "per_unit" }] })).toBe("mile");
  });

  it("never offers a unit the company switched off", () => {
    // A freight carrier's catalog still names tons, but tons are switched off: the freight unit is used.
    const charges = [{ default_unit_code: "ton", kind: "hauling", calc_method: "per_unit", active: true }];
    expect(defaultLineUnit({ kind: "hauling", industry: "freight", units: FREIGHT_UNITS, charges })).toBe("mile");
    // Neither the catalog's nor the industry's unit is active: "each", else the first active unit.
    expect(defaultLineUnit({ kind: "hauling", industry: "aggregate", units: [{ code: "each", active: true }, { code: "ton", active: false }] })).toBe("each");
    expect(defaultLineUnit({ kind: "hauling", industry: "aggregate", units: [{ code: "day", active: true }] })).toBe("day");
    expect(defaultLineUnit({ kind: "hauling", industry: "aggregate", units: [] })).toBeNull();
  });

  it("keeps other custom charges in each (lumper fee, truck ordered not used)", () => {
    expect(defaultLineUnit({ kind: "other", industry: "freight", units: FREIGHT_UNITS })).toBe("each");
    expect(defaultLineUnit({ kind: "other", industry: "aggregate", units: ALL })).toBe("each");
  });
});
