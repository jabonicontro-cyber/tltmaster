import { z } from "zod";

// Truck routing dimensions (20261120002600). Stored metric (cm, kg) as the routing provider expects; entered and shown
// in feet and pounds. Ranges match the database checks, so a value the form accepts is a value the database accepts.

export const CM_PER_FT = 30.48;
export const KG_PER_LB = 0.45359237;

export const DIMENSION_LIMITS = {
  height_cm: { min: 150, max: 600 },
  width_cm: { min: 150, max: 400 },
  length_cm: { min: 300, max: 3000 },
  gross_weight_kg: { min: 1000, max: 100000 },
} as const;

/** Feet with one decimal (13.5 = 13 ft 6 in); empty when unknown. */
export const cmToFeet = (cm: number | null | undefined) => (cm == null ? "" : String(Math.round((cm / CM_PER_FT) * 10) / 10));
/** Pounds to the nearest 10 (kilograms are stored whole, about 2 lb apart); empty when unknown. */
export const kgToPounds = (kg: number | null | undefined) => (kg == null ? "" : String(Math.round(kg / KG_PER_LB / 10) * 10));

const clean = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim().replace(/,/g, ""));

function metric(label: string, column: keyof typeof DIMENSION_LIMITS, perUnit: number, unit: string, decimals: number) {
  const { min, max } = DIMENSION_LIMITS[column];
  const lo = Math.ceil((min / perUnit) * 10 ** decimals) / 10 ** decimals;
  const hi = Math.floor((max / perUnit) * 10 ** decimals) / 10 ** decimals;
  return z.preprocess(
    clean,
    z
      .string()
      .refine((v) => v === "" || (/^\d+(\.\d+)?$/.test(v) && Number(v) >= lo && Number(v) <= hi), `${label}: enter ${lo}–${hi} ${unit}, or leave blank if not known.`)
      .transform((v) => (v === "" ? null : Math.min(max, Math.max(min, Math.round(Number(v) * perUnit))))),
  );
}

/** Form fields (feet, pounds) → database columns (cm, kg). Empty means not known. */
export const truckDimensionFields = {
  height_cm: metric("Height", "height_cm", CM_PER_FT, "ft", 1),
  width_cm: metric("Width", "width_cm", CM_PER_FT, "ft", 1),
  length_cm: metric("Length", "length_cm", CM_PER_FT, "ft", 1),
  gross_weight_kg: metric("Gross weight", "gross_weight_kg", KG_PER_LB, "lb", 0),
  axle_count: z.preprocess(
    clean,
    z
      .string()
      .refine((v) => v === "" || (/^\d{1,2}$/.test(v) && Number(v) >= 2 && Number(v) <= 12), "Axles: enter 2–12, or leave blank if not known.")
      .transform((v) => (v === "" ? null : Number(v))),
  ),
};

export const truckDimensionsSchema = z.object(truckDimensionFields);
export type TruckDimensions = z.output<typeof truckDimensionsSchema>;
