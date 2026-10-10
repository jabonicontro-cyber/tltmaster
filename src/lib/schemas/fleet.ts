import { z } from "zod";
import { isIsoDate } from "@/lib/dates";
import { CDL_CLASSES, QUALIFICATION_KINDS, TRAILER_TYPES, TRUCK_TYPES } from "@/lib/fleet/labels";
import { checkbox, optionalPhone, optionalText } from "./common";

const emptyToNull = (v: unknown) => (v === "" || v === undefined ? null : v);

const optionalDate = z.preprocess(emptyToNull, z.string().refine(isIsoDate, "Enter a valid date.").nullable());

/** Up to 3 decimals, greater than 0, at most 9,999,999.999. Empty = unknown. */
const capacityValue = z.preprocess(
  (v) => (v === undefined || v === null ? "" : typeof v === "string" ? v.trim().replace(/,/g, "") : String(v)),
  z
    .string()
    .refine((v) => v === "" || (/^\d{1,7}(\.\d{1,3})?$/.test(v) && Number(v) > 0), "Enter a number greater than 0 with up to 3 decimals, or leave blank if unknown.")
    .transform((v) => (v === "" ? null : v)),
);

const unitNumber = z
  .string()
  .trim()
  .min(1, "Unit number is required.")
  .max(20, "Maximum 20 characters.");

const modelYear = z.preprocess(
  emptyToNull,
  z.coerce.number({ error: "Enter a 4-digit year." }).int("Enter a 4-digit year.").min(1950, "Enter a year from 1950.").max(2100, "Enter a valid year.").nullable(),
);

const vin = z
  .string()
  .trim()
  .toUpperCase()
  .default("")
  .refine((v) => v === "" || /^[A-HJ-NPR-Z0-9]{17}$/.test(v), "A VIN has 17 letters and digits (no I, O or Q).");

const plateState = z
  .string()
  .trim()
  .toUpperCase()
  .default("")
  .refine((v) => v === "" || /^[A-Z]{2}$/.test(v), "Use the 2-letter state code.");

/** Shared by trucks and trailers. */
const equipmentFields = {
  unit_number: unitNumber,
  make: optionalText(60),
  model: optionalText(60),
  model_year: modelYear,
  vin,
  license_plate: optionalText(15),
  plate_state: plateState,
  weight_capacity: capacityValue,
  weight_unit: z.preprocess(emptyToNull, z.enum(["ton", "lb"], { error: "Choose tons or pounds." }).nullable()),
  volume_capacity: capacityValue,
  capacity_source: optionalText(200),
  capacity_verified: checkbox,
  notes: optionalText(4000),
};

function capacityRules(e: { weight_capacity: string | null; weight_unit: string | null; volume_capacity: string | null; capacity_verified: boolean }, ctx: z.RefinementCtx) {
  if (e.weight_capacity !== null && !e.weight_unit) ctx.addIssue({ code: "custom", message: "Choose the unit for this weight.", path: ["weight_unit"] });
  if (e.capacity_verified && e.weight_capacity === null && e.volume_capacity === null)
    ctx.addIssue({ code: "custom", message: "Enter a capacity before marking it verified.", path: ["capacity_verified"] });
}

export const truckSchema = z
  .object({
    ...equipmentFields,
    truck_type: z.enum(TRUCK_TYPES as [string, ...string[]], { error: "Choose the truck type." }),
  })
  .superRefine(capacityRules);

export const trailerSchema = z
  .object({
    ...equipmentFields,
    trailer_type: z.enum(TRAILER_TYPES as [string, ...string[]], { error: "Choose the trailer type." }),
    compatible_truck_types: z.array(z.enum(TRUCK_TYPES as [string, ...string[]])).default([]),
    compatibility_notes: optionalText(1000),
    default_truck_id: z.preprocess(emptyToNull, z.uuid().nullable()),
  })
  .superRefine(capacityRules);

export type TruckInput = z.output<typeof truckSchema>;
export type TrailerInput = z.output<typeof trailerSchema>;

/** Row values for the database; unit null when the value is unknown. */
export function toEquipmentRow<T extends z.output<typeof truckSchema> | z.output<typeof trailerSchema>>(e: T) {
  const { capacity_verified, ...rest } = e;
  return {
    ...rest,
    weight_unit: rest.weight_capacity === null ? null : rest.weight_unit,
    volume_unit: rest.volume_capacity === null ? null : ("cu_yd" as const),
    // Any timestamp means "verified"; the database records who and when.
    capacity_verified_at: capacity_verified ? new Date().toISOString() : null,
  };
}

/** Parse a trailer FormData, collecting the repeated compatible_truck_types field. */
export function trailerFormValues(formData: FormData) {
  return { ...Object.fromEntries(formData), compatible_truck_types: formData.getAll("compatible_truck_types") };
}

export const serviceStatusSchema = z
  .object({
    kind: z.enum(["truck", "trailer"]),
    id: z.uuid("Invalid equipment."),
    status: z.enum(["in_service", "out_of_service"]),
    reason: optionalText(500),
    expected_return_date: optionalDate,
  })
  .superRefine((s, ctx) => {
    if (s.status === "out_of_service" && !s.reason) ctx.addIssue({ code: "custom", message: "Enter the reason it is out of service.", path: ["reason"] });
  });

export const driverSchema = z
  .object({
    user_id: z.preprocess(emptyToNull, z.uuid().nullable()),
    name: optionalText(120),
    employee_number: optionalText(20),
    phone: optionalPhone,
    hire_date: optionalDate,
    notes: optionalText(4000),
  })
  .superRefine((d, ctx) => {
    if (!d.user_id && !d.name) ctx.addIssue({ code: "custom", message: "Enter the driver's name, or link an existing user.", path: ["name"] });
  });

export const qualificationSchema = z
  .object({
    kind: z.enum(QUALIFICATION_KINDS as [string, ...string[]], { error: "Choose the qualification type." }),
    cdl_class: z.preprocess(emptyToNull, z.enum(CDL_CLASSES as [string, ...string[]]).nullable()),
    endorsements: z.string().trim().toUpperCase().max(60).default(""),
    description: optionalText(120),
    issuing_state: plateState,
    issued_on: optionalDate,
    expires_on: optionalDate,
    verified: checkbox,
    notes: optionalText(1000),
  })
  .superRefine((q, ctx) => {
    if (q.kind === "cdl" && !q.cdl_class) ctx.addIssue({ code: "custom", message: "Choose the CDL class.", path: ["cdl_class"] });
    if (q.kind === "other" && !q.description) ctx.addIssue({ code: "custom", message: "Describe the qualification.", path: ["description"] });
    if (q.issued_on && q.expires_on && q.expires_on < q.issued_on) ctx.addIssue({ code: "custom", message: "Must be on or after the issue date.", path: ["expires_on"] });
  });

export function toQualificationRow(q: z.output<typeof qualificationSchema>) {
  const { verified, ...rest } = q;
  return {
    ...rest,
    cdl_class: q.kind === "cdl" ? q.cdl_class : null,
    verified_at: verified ? new Date().toISOString() : null,
  };
}
