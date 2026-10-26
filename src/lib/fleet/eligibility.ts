// Dispatch readiness rules. Mirrors public.check_assignment_eligibility and
// private.qualification_check (supabase/migrations/20261013000100_fleet_registry.sql);
// tests/db/fleet.test.ts proves they agree.
//
//   active    — the record is not deactivated (administrative).
//   available — active, and for trucks and trailers also in service.
//   eligible  — available, and for a given date and combination the trailer
//               fits the truck and the driver holds a verified, unexpired CDL of
//               the required class (A with a trailer, otherwise B or A) and a
//               verified, unexpired medical card. Unknown is never treated as OK.
import { addDays } from "@/lib/dates";
import type { CdlClass, QualificationKind, ServiceStatus, TruckType } from "@/server/data/types";

export type QualificationState = "ok" | "missing" | "class_insufficient" | "expired" | "expiry_unknown" | "unverified";

export interface EligibilityQualification {
  kind: QualificationKind;
  cdl_class: CdlClass | null;
  expires_on: string | null;
  verified_at: string | null;
}

interface CapacityInput {
  weight_capacity: string | number | null;
  volume_capacity: string | number | null;
  capacity_verified_at: string | null;
}

export interface EligibilityTruck extends CapacityInput {
  active: boolean;
  service_status: ServiceStatus;
  truck_type: TruckType;
}

export interface EligibilityTrailer extends CapacityInput {
  active: boolean;
  service_status: ServiceStatus;
  compatible_truck_types: TruckType[];
}

export interface EligibilityDriver {
  active: boolean;
  qualifications: EligibilityQualification[];
}

export interface EligibilityResult {
  eligible: boolean;
  blockers: string[];
  warnings: string[];
}

/** Days before expiry at which a valid qualification starts to warn. */
export const EXPIRY_WARNING_DAYS = 30;

const CLASS_RANK: Record<CdlClass, number> = { A: 3, B: 2, C: 1 };

export function classCovers(held: CdlClass | null, required: CdlClass | null): boolean {
  if (!required) return true;
  return held !== null && CLASS_RANK[held] >= CLASS_RANK[required];
}

/** First reason that applies: missing → class_insufficient → (ok) → expired → expiry_unknown → unverified. */
export function qualificationCheck(quals: EligibilityQualification[], kind: QualificationKind, minClass: CdlClass | null, on: string): QualificationState {
  const ofKind = quals.filter((q) => q.kind === kind);
  if (ofKind.length === 0) return "missing";
  const classed = ofKind.filter((q) => classCovers(q.cdl_class, minClass));
  if (classed.length === 0) return "class_insufficient";
  if (classed.some((q) => q.verified_at && q.expires_on !== null && q.expires_on >= on)) return "ok";
  if (!classed.some((q) => q.expires_on === null || q.expires_on >= on)) return "expired";
  if (!classed.some((q) => q.expires_on !== null && q.expires_on >= on)) return "expiry_unknown";
  return "unverified";
}

function expiresAfter(quals: EligibilityQualification[], kind: QualificationKind, minClass: CdlClass | null, date: string): boolean {
  return quals.some((q) => q.kind === kind && classCovers(q.cdl_class, minClass) && q.verified_at && q.expires_on !== null && q.expires_on > date);
}

function hasCapacity(e: CapacityInput) {
  return e.weight_capacity !== null || e.volume_capacity !== null;
}

/** The CDL class a driver needs for this combination. */
export function requiredCdlClass(withTrailer: boolean): CdlClass {
  return withTrailer ? "A" : "B";
}

export function evaluateAssignment(
  input: { truck?: EligibilityTruck | null; trailer?: EligibilityTrailer | null; driver?: EligibilityDriver | null },
  on: string,
): EligibilityResult {
  const { truck, trailer, driver } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (truck) {
    if (!truck.active) blockers.push("truck_inactive");
    if (truck.service_status === "out_of_service") blockers.push("truck_out_of_service");
    if (!hasCapacity(truck)) warnings.push("truck_capacity_unknown");
    else if (!truck.capacity_verified_at) warnings.push("truck_capacity_unverified");
  }

  if (trailer) {
    if (!trailer.active) blockers.push("trailer_inactive");
    if (trailer.service_status === "out_of_service") blockers.push("trailer_out_of_service");
    if (!hasCapacity(trailer)) warnings.push("trailer_capacity_unknown");
    else if (!trailer.capacity_verified_at) warnings.push("trailer_capacity_unverified");
    if (truck) {
      if (trailer.compatible_truck_types.length === 0) warnings.push("trailer_compatibility_unknown");
      else if (!trailer.compatible_truck_types.includes(truck.truck_type)) blockers.push("trailer_incompatible");
    }
  }

  if (driver) {
    const d = driverChecks(driver, Boolean(trailer), on);
    blockers.push(...d.blockers);
    warnings.push(...d.warnings);
  }

  return { eligible: blockers.length === 0, blockers, warnings };
}

/** The driver part of the rules: active, CDL of the required class, medical card. */
export function driverChecks(driver: EligibilityDriver, withTrailer: boolean, on: string): EligibilityResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const soon = addDays(on, EXPIRY_WARNING_DAYS);
  if (!driver.active) blockers.push("driver_inactive");
  const min = requiredCdlClass(withTrailer);
  const cdl = qualificationCheck(driver.qualifications, "cdl", min, on);
  if (cdl !== "ok") blockers.push(`cdl_${cdl}`);
  else if (!expiresAfter(driver.qualifications, "cdl", min, soon)) warnings.push("cdl_expiring_soon");
  const med = qualificationCheck(driver.qualifications, "medical_card", null, on);
  if (med !== "ok") blockers.push(`medical_card_${med}`);
  else if (!expiresAfter(driver.qualifications, "medical_card", null, soon)) warnings.push("medical_card_expiring_soon");
  return { eligible: blockers.length === 0, blockers, warnings };
}

/** Human-readable text for blocker and warning codes. */
export const ELIGIBILITY_MESSAGES: Record<string, string> = {
  truck_inactive: "Truck is deactivated.",
  truck_out_of_service: "Truck is out of service.",
  truck_safety_report_open: "A driver reported a breakdown or inspection problem on this truck that is not resolved yet.",
  trailer_safety_report_open: "A driver reported a breakdown or inspection problem on this trailer that is not resolved yet.",
  truck_equipment_report_open: "A driver reported an equipment issue on this truck that is not resolved yet.",
  trailer_equipment_report_open: "A driver reported an equipment issue on this trailer that is not resolved yet.",
  truck_safety_restricted: "Truck has an open safety-critical work order. It returns to service only after an authorized inspection clears it.",
  truck_shop_scheduled: "Truck is scheduled in the shop on this date.",
  truck_shop_work_open: "Truck has shop work in progress or waiting for parts — check with the shop.",
  trailer_safety_restricted: "Trailer has an open safety-critical work order. It returns to service only after an authorized inspection clears it.",
  trailer_shop_scheduled: "Trailer is scheduled in the shop on this date.",
  trailer_shop_work_open: "Trailer has shop work in progress or waiting for parts — check with the shop.",
  truck_capacity_unknown: "Truck capacity is not recorded.",
  truck_capacity_unverified: "Truck capacity is recorded but not verified.",
  trailer_inactive: "Trailer is deactivated.",
  trailer_out_of_service: "Trailer is out of service.",
  trailer_capacity_unknown: "Trailer capacity is not recorded.",
  trailer_capacity_unverified: "Trailer capacity is recorded but not verified.",
  trailer_incompatible: "This trailer is not recorded as compatible with this truck type.",
  trailer_compatibility_unknown: "Trailer compatibility is not recorded.",
  trailer_required: "A tractor needs a trailer for this load.",
  driver_inactive: "Driver is inactive.",
  driver_time_off: "Driver has approved time off on this date.",
  driver_partial_time_off: "Driver has approved partial-day time off on this date — check the load times.",
  driver_time_off_pending: "Driver has a pending time-off request on this date.",
  driver_off_shift: "Assigned outside the driver's scheduled shift (a reason was recorded).",
  cdl_missing: "No CDL is recorded for this driver.",
  cdl_class_insufficient: "Driver's CDL class is not high enough for this combination.",
  cdl_expired: "Driver's CDL has expired.",
  cdl_expiry_unknown: "Driver's CDL expiry date is not recorded.",
  cdl_unverified: "Driver's CDL has not been verified.",
  cdl_expiring_soon: `Driver's CDL expires within ${EXPIRY_WARNING_DAYS} days.`,
  medical_card_missing: "No DOT medical card is recorded for this driver.",
  medical_card_class_insufficient: "Medical card does not qualify.",
  medical_card_expired: "Driver's medical card has expired.",
  medical_card_expiry_unknown: "Driver's medical card expiry date is not recorded.",
  medical_card_unverified: "Driver's medical card has not been verified.",
  medical_card_expiring_soon: `Driver's medical card expires within ${EXPIRY_WARNING_DAYS} days.`,
};

export function eligibilityMessage(code: string): string {
  return ELIGIBILITY_MESSAGES[code] ?? code;
}

/** Driver readiness without a specific truck: needs at least a class B CDL and a medical card. */
export function driverReadiness(driver: EligibilityDriver, on: string): EligibilityResult {
  return evaluateAssignment({ driver }, on);
}

/** Qualifications that expire between `on` and `on + days` (inclusive), or have already expired. */
export function expiringQualifications<T extends { expires_on: string | null }>(quals: T[], on: string, days = EXPIRY_WARNING_DAYS): T[] {
  const limit = addDays(on, days);
  return quals.filter((q) => q.expires_on !== null && q.expires_on <= limit).sort((a, b) => (a.expires_on! < b.expires_on! ? -1 : 1));
}
