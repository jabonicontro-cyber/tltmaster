import { z } from "zod";
import { parsePercentToBp } from "@/lib/money";
import { ROLES } from "@/lib/permissions";
import { optionalEmail, optionalPhone, optionalText, postalCode, requiredText, stateCode } from "./common";

export const TIMEZONES = ["America/Chicago", "America/New_York", "America/Indiana/Indianapolis", "America/Denver", "America/Los_Angeles"] as const;

export const companySettingsSchema = z
  .object({
    company_name: requiredText(120, "Company name"),
    address_line1: optionalText(200),
    address_line2: optionalText(200),
    city: optionalText(80),
    state: stateCode,
    postal_code: postalCode,
    phone: optionalPhone,
    email: optionalEmail,
    website: optionalText(120),
    timezone: z.enum(TIMEZONES),
    default_tax_rate: z.string().trim().default("0"),
    quote_validity_days: z.coerce.number().int().min(1, "At least 1 day.").max(365),
    quote_followup_days: z.coerce.number().int().min(1).max(90),
    default_quote_terms: optionalText(8000),
    quote_footer_note: optionalText(300),
  })
  .superRefine((v, ctx) => {
    const bp = parsePercentToBp(v.default_tax_rate || "0");
    if (bp === null || bp > 2500) ctx.addIssue({ code: "custom", message: "Enter a rate between 0 and 25.", path: ["default_tax_rate"] });
  })
  .transform(({ default_tax_rate, ...rest }) => ({ ...rest, default_tax_rate_bp: parsePercentToBp(default_tax_rate || "0") ?? 0 }));

export const sequenceSchema = z.object({
  prefix: z.string().trim().max(10).regex(/^[A-Za-z0-9-]*$/, "Letters, numbers and dashes only."),
  include_year: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
  pad: z.coerce.number().int().min(1).max(10),
  next_value: z.coerce.number().int().min(1, "Must be at least 1."),
});

export const inviteSchema = z.object({
  email: z.email("Enter a valid email address."),
  full_name: requiredText(120, "Name"),
  role: z.enum(ROLES),
});

export const userAccessSchema = z.object({
  full_name: requiredText(120, "Name"),
  role: z.preprocess((v) => (v === "" ? null : v), z.enum(ROLES).nullable()),
  active: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
});
