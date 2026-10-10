import { z } from "zod";
import { parseMoneyToCents, parsePercentToBp } from "@/lib/money";
import { isIsoDate } from "@/lib/dates";
import { checkbox, optionalText, requiredText } from "./common";

const code = z
  .string()
  .trim()
  .max(30)
  .default("")
  .refine((v) => v === "" || /^[A-Za-z0-9._-]+$/.test(v), "Use letters, numbers, dot, dash or underscore.")
  .transform((v) => (v === "" ? null : v.toUpperCase()));

export const materialSchema = z.object({
  name: requiredText(120, "Name"),
  code,
  description: optionalText(1000),
  default_unit_code: z.string().min(1, "Choose a default unit."),
  taxable_default: checkbox,
});

export const chargeItemSchema = z
  .object({
    name: requiredText(120, "Name"),
    code,
    description: optionalText(1000),
    kind: z.enum(["hauling", "service", "surcharge", "discount", "other"], { error: "Choose a charge type." }),
    calc_method: z.enum(["per_unit", "percent_of_subtotal"], { error: "Choose how the charge is calculated." }),
    default_unit_code: z.preprocess((v) => (v === "" ? null : v), z.string().nullable()),
    taxable_default: checkbox,
  })
  .refine((v) => v.calc_method !== "per_unit" || v.default_unit_code, {
    message: "Per-unit charges need a default unit.",
    path: ["default_unit_code"],
  })
  .transform((v) => (v.calc_method === "per_unit" ? v : { ...v, default_unit_code: null }));

export const unitSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{1,20}$/, "Lowercase letters, numbers and underscores only (max 20)."),
  label: requiredText(40, "Label"),
  abbreviation: requiredText(12, "Abbreviation"),
  sort_order: z.coerce.number().int().min(0).max(1000).default(100),
});

export const priceListSchema = z.object({
  name: requiredText(120, "Name"),
  description: optionalText(500),
});

const isoDate = z.string().refine(isIsoDate, "Enter a valid date.");

export const priceEntrySchema = z
  .object({
    item: z.string().regex(/^(material|charge):[0-9a-f-]{36}$/, "Choose a material or charge."),
    pricing: z.enum(["rate", "percent"]),
    unit_code: z.preprocess((v) => (v === "" ? null : v), z.string().nullable()),
    rate: z.string().default(""),
    percent: z.string().default(""),
    effective_from: isoDate,
    effective_to: z.preprocess((v) => (v === "" ? null : v), isoDate.nullable()),
    notes: optionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.pricing === "rate") {
      if (!v.unit_code) ctx.addIssue({ code: "custom", message: "Choose a unit.", path: ["unit_code"] });
      const cents = parseMoneyToCents(v.rate);
      if (cents === null || cents < 0 || cents > 100_000_000) ctx.addIssue({ code: "custom", message: "Enter a rate like 12.50.", path: ["rate"] });
    } else {
      const bp = parsePercentToBp(v.percent);
      if (bp === null || bp < 1 || bp > 10000) ctx.addIssue({ code: "custom", message: "Enter a percentage between 0.01 and 100.", path: ["percent"] });
    }
    if (v.effective_to && v.effective_to < v.effective_from) {
      ctx.addIssue({ code: "custom", message: "End date must be on or after the start date.", path: ["effective_to"] });
    }
  })
  .transform((v) => {
    const [kind, id] = v.item.split(":");
    return {
      material_id: kind === "material" ? id : null,
      charge_item_id: kind === "charge" ? id : null,
      unit_code: v.pricing === "rate" ? v.unit_code : null,
      rate_cents: v.pricing === "rate" ? parseMoneyToCents(v.rate) : null,
      percent_bp: v.pricing === "percent" ? parsePercentToBp(v.percent) : null,
      effective_from: v.effective_from,
      effective_to: v.effective_to,
      notes: v.notes,
    };
  });

export const CHARGE_KIND_LABELS: Record<string, string> = {
  material: "Material",
  hauling: "Hauling / delivery",
  service: "Service / hourly",
  surcharge: "Surcharge",
  discount: "Discount",
  other: "Other",
};
