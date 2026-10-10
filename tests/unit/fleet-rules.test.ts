import { describe, expect, it } from "vitest";
import { classCovers, evaluateAssignment, expiringQualifications, qualificationCheck, requiredCdlClass, type EligibilityQualification } from "@/lib/fleet/eligibility";
import { capacityState, formatCapacity, trimNumber, weightInPounds } from "@/lib/fleet/labels";
import { driverSchema, qualificationSchema, toEquipmentRow, trailerSchema, truckSchema } from "@/lib/schemas/fleet";

const ON = "2026-10-10";
const V = "2026-01-01T00:00:00Z";
const q = (kind: EligibilityQualification["kind"], extra: Partial<EligibilityQualification> = {}): EligibilityQualification => ({
  kind,
  cdl_class: kind === "cdl" ? "A" : null,
  expires_on: "2028-01-01",
  verified_at: V,
  ...extra,
});
const truck = { active: true, service_status: "in_service" as const, truck_type: "tractor" as const, weight_capacity: 25, volume_capacity: null, capacity_verified_at: V };
const trailer = { active: true, service_status: "in_service" as const, compatible_truck_types: ["tractor" as const], weight_capacity: null, volume_capacity: 24, capacity_verified_at: V };
const driver = { active: true, qualifications: [q("cdl"), q("medical_card")] };

describe("qualification checks", () => {
  it("never treats missing, expired, unverified or undated qualifications as valid", () => {
    expect(qualificationCheck([], "cdl", "B", ON)).toBe("missing");
    expect(qualificationCheck([q("cdl", { cdl_class: "C" })], "cdl", "B", ON)).toBe("class_insufficient");
    expect(qualificationCheck([q("cdl", { expires_on: "2026-10-09" })], "cdl", "B", ON)).toBe("expired");
    expect(qualificationCheck([q("cdl", { expires_on: null })], "cdl", "B", ON)).toBe("expiry_unknown");
    expect(qualificationCheck([q("cdl", { verified_at: null })], "cdl", "B", ON)).toBe("unverified");
    expect(qualificationCheck([q("cdl", { expires_on: ON })], "cdl", "B", ON)).toBe("ok"); // valid through its expiry date
    expect(qualificationCheck([q("cdl", { expires_on: "2020-01-01" }), q("cdl")], "cdl", "A", ON)).toBe("ok"); // renewed
  });

  it("ranks CDL classes", () => {
    expect(classCovers("A", "B")).toBe(true);
    expect(classCovers("B", "A")).toBe(false);
    expect(classCovers("C", "B")).toBe(false);
    expect(classCovers(null, "B")).toBe(false);
    expect(requiredCdlClass(true)).toBe("A");
    expect(requiredCdlClass(false)).toBe("B");
  });

  it("lists qualifications expiring soon or already expired", () => {
    const list = [{ expires_on: "2026-12-31" }, { expires_on: "2026-10-20" }, { expires_on: null }, { expires_on: "2026-09-01" }];
    expect(expiringQualifications(list, ON)).toEqual([{ expires_on: "2026-09-01" }, { expires_on: "2026-10-20" }]);
  });
});

describe("assignment eligibility", () => {
  it("passes a fully ready combination", () => {
    expect(evaluateAssignment({ truck, trailer, driver }, ON)).toEqual({ eligible: true, blockers: [], warnings: [] });
  });

  it("distinguishes inactive, out of service and incompatible", () => {
    const r = evaluateAssignment({ truck: { ...truck, active: false }, trailer: { ...trailer, service_status: "out_of_service" }, driver: { ...driver, active: false } }, ON);
    expect(r.blockers).toEqual(["truck_inactive", "trailer_out_of_service", "driver_inactive"]);
    expect(evaluateAssignment({ truck: { ...truck, truck_type: "tri_axle_dump" }, trailer }, ON).blockers).toEqual(["trailer_incompatible"]);
  });

  it("warns, without blocking, about unknown capacity and compatibility", () => {
    const r = evaluateAssignment({ truck: { ...truck, weight_capacity: null }, trailer: { ...trailer, compatible_truck_types: [], capacity_verified_at: null } }, ON);
    expect(r).toEqual({ eligible: true, blockers: [], warnings: ["truck_capacity_unknown", "trailer_capacity_unverified", "trailer_compatibility_unknown"] });
  });

  it("requires class A with a trailer and warns about expiries within 30 days", () => {
    const classB = { active: true, qualifications: [q("cdl", { cdl_class: "B" }), q("medical_card", { expires_on: "2026-10-30" })] };
    expect(evaluateAssignment({ truck, driver: classB }, ON)).toEqual({ eligible: true, blockers: [], warnings: ["medical_card_expiring_soon"] });
    expect(evaluateAssignment({ truck, trailer, driver: classB }, ON).blockers).toEqual(["cdl_class_insufficient"]);
  });
});

describe("capacity display", () => {
  it("shows unknown, unverified and verified capacities with explicit units", () => {
    const base = { weight_capacity: null, weight_unit: null, volume_capacity: null, volume_unit: null, capacity_verified_at: null };
    expect(formatCapacity(base)).toBeNull();
    expect(capacityState(base)).toBe("unknown");
    const both = { ...base, weight_capacity: "22.500", weight_unit: "ton" as const, volume_capacity: 18, volume_unit: "cu_yd" as const };
    expect(formatCapacity(both)).toBe("22.5 tons · 18 cu yd");
    expect(capacityState(both)).toBe("unverified");
    expect(capacityState({ ...both, capacity_verified_at: V })).toBe("verified");
    expect(formatCapacity({ ...base, weight_capacity: 45000, weight_unit: "lb" })).toBe("45000 lb");
    expect(trimNumber("40.000")).toBe("40");
    expect(weightInPounds("22.5", "ton")).toBe(45000);
    expect(weightInPounds(45000, "lb")).toBe(45000);
  });
});

describe("fleet input validation", () => {
  it("requires a unit for a weight and refuses verifying an empty capacity", () => {
    expect(truckSchema.safeParse({ unit_number: "101", truck_type: "tri_axle_dump", weight_capacity: "20" }).success).toBe(false);
    expect(truckSchema.safeParse({ unit_number: "101", truck_type: "tri_axle_dump", capacity_verified: "on" }).success).toBe(false);
    expect(truckSchema.safeParse({ unit_number: "101", truck_type: "tri_axle_dump", weight_capacity: "-1", weight_unit: "ton" }).success).toBe(false);
    expect(truckSchema.safeParse({ unit_number: "101", truck_type: "tri_axle_dump", vin: "123" }).success).toBe(false);
    expect(truckSchema.safeParse({ unit_number: " ", truck_type: "tri_axle_dump" }).success).toBe(false);
    const ok = truckSchema.parse({ unit_number: "101", truck_type: "tri_axle_dump", weight_capacity: "22.5", weight_unit: "ton", volume_capacity: "", capacity_verified: "on", model_year: "" });
    const row = toEquipmentRow(ok);
    expect(row).toMatchObject({ weight_capacity: "22.5", weight_unit: "ton", volume_capacity: null, volume_unit: null, model_year: null });
    expect(row.capacity_verified_at).not.toBeNull();
    expect(toEquipmentRow(truckSchema.parse({ unit_number: "101", truck_type: "other", volume_capacity: "18" }))).toMatchObject({ volume_unit: "cu_yd", capacity_verified_at: null });
  });

  it("validates trailers, drivers and qualifications", () => {
    expect(trailerSchema.parse({ unit_number: "R1", trailer_type: "end_dump", compatible_truck_types: ["tractor"] }).compatible_truck_types).toEqual(["tractor"]);
    expect(trailerSchema.safeParse({ unit_number: "R1", trailer_type: "end_dump", compatible_truck_types: ["bicycle"] }).success).toBe(false);
    expect(driverSchema.safeParse({ name: "" }).success).toBe(false);
    expect(driverSchema.safeParse({ name: "", user_id: "00000000-0000-4000-8000-000000000001" }).success).toBe(true);
    expect(qualificationSchema.safeParse({ kind: "cdl" }).success).toBe(false);
    expect(qualificationSchema.safeParse({ kind: "other" }).success).toBe(false);
    expect(qualificationSchema.safeParse({ kind: "medical_card", issued_on: "2026-05-01", expires_on: "2026-04-01" }).success).toBe(false);
    expect(qualificationSchema.parse({ kind: "cdl", cdl_class: "A", endorsements: " n, t " }).endorsements).toBe("N, T");
  });
});
