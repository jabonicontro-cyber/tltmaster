// Labels and display helpers for the fleet registry.
import { formatDate } from "@/lib/dates";
import type { CdlClass, QualificationKind, ServiceStatus, TrailerType, TruckType, WeightUnit } from "@/server/data/types";

export const TRUCK_TYPES: TruckType[] = ["single_axle_dump", "tandem_axle_dump", "tri_axle_dump", "quad_axle_dump", "tractor", "other"];
export const TRUCK_TYPE_LABELS: Record<TruckType, string> = {
  single_axle_dump: "Single-axle dump",
  tandem_axle_dump: "Tandem-axle dump",
  tri_axle_dump: "Tri-axle dump",
  quad_axle_dump: "Quad-axle dump",
  tractor: "Tractor (semi)",
  other: "Other",
};

export const TRAILER_TYPES: TrailerType[] = ["end_dump", "belly_dump", "side_dump", "live_floor", "pup", "lowboy", "flatbed", "other"];
export const TRAILER_TYPE_LABELS: Record<TrailerType, string> = {
  end_dump: "End dump",
  belly_dump: "Belly dump",
  side_dump: "Side dump",
  live_floor: "Live floor",
  pup: "Pup trailer",
  lowboy: "Lowboy",
  flatbed: "Flatbed",
  other: "Other",
};

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  in_service: "In service",
  out_of_service: "Out of service",
};

export const WEIGHT_UNIT_LABELS: Record<WeightUnit, string> = { ton: "tons", lb: "lb" };

export const QUALIFICATION_KINDS: QualificationKind[] = ["cdl", "medical_card", "hazmat", "twic", "other"];
export const QUALIFICATION_LABELS: Record<QualificationKind, string> = {
  cdl: "Commercial driver's license (CDL)",
  medical_card: "DOT medical card",
  hazmat: "Hazmat endorsement",
  twic: "TWIC card",
  other: "Other",
};
export const QUALIFICATION_SHORT: Record<QualificationKind, string> = {
  cdl: "CDL",
  medical_card: "Medical card",
  hazmat: "Hazmat",
  twic: "TWIC",
  other: "Other",
};
export const CDL_CLASSES: CdlClass[] = ["A", "B", "C"];

/** 22.5 / "22.500" → "22.5"; 40 / "40.000" → "40" (numeric arrives as a number from the API, a string from node-postgres). */
export function trimNumber(value: string | number): string {
  const s = String(value);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export interface CapacityFields {
  weight_capacity: string | number | null;
  weight_unit: WeightUnit | null;
  volume_capacity: string | number | null;
  volume_unit: "cu_yd" | null;
  capacity_verified_at: string | null;
}

/** "22.5 tons · 18 cu yd", or null when nothing is recorded (unknown). */
export function formatCapacity(e: CapacityFields): string | null {
  const parts: string[] = [];
  if (e.weight_capacity !== null && e.weight_unit) parts.push(`${trimNumber(e.weight_capacity)} ${WEIGHT_UNIT_LABELS[e.weight_unit]}`);
  if (e.volume_capacity !== null && e.volume_unit) parts.push(`${trimNumber(e.volume_capacity)} cu yd`);
  return parts.length ? parts.join(" · ") : null;
}

export type CapacityState = "unknown" | "unverified" | "verified";

export function capacityState(e: CapacityFields): CapacityState {
  if (formatCapacity(e) === null) return "unknown";
  return e.capacity_verified_at ? "verified" : "unverified";
}

/** Weight in pounds for comparing capacities entered in different units (1 short ton = 2,000 lb). */
export function weightInPounds(value: string | number, unit: WeightUnit): number {
  const n = typeof value === "number" ? value : Number(value);
  return unit === "ton" ? n * 2000 : n;
}

export function equipmentTitle(e: { unit_number: string; model_year: number | null; make: string; model: string }): string {
  const desc = [e.model_year, e.make, e.model].filter(Boolean).join(" ");
  return desc ? `${e.unit_number} — ${desc}` : e.unit_number;
}

export function qualificationName(q: { kind: QualificationKind; cdl_class: CdlClass | null; description: string }): string {
  if (q.kind === "cdl") return `CDL class ${q.cdl_class ?? "?"}`;
  if (q.kind === "other") return q.description || "Other";
  return QUALIFICATION_SHORT[q.kind];
}

export function formatExpiry(expiresOn: string | null): string {
  return expiresOn ? formatDate(expiresOn) : "Expiry not recorded";
}
