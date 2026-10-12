import { z } from "zod";
import { isUsernameEmail } from "@/lib/usernames";
import { parsePercentToBp } from "@/lib/money";
import { ROLES } from "@/lib/permissions";
import { optionalEmail, optionalPhone, optionalText, postalCode, requiredText, stateCode } from "./common";

/** Business time zones a company can choose (each company sets its own; nothing is assumed). */
export const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern (New York)" },
  { value: "America/Indiana/Indianapolis", label: "Eastern (Indianapolis)" },
  { value: "America/Detroit", label: "Eastern (Detroit)" },
  { value: "America/Chicago", label: "Central (Chicago)" },
  { value: "America/Denver", label: "Mountain (Denver)" },
  { value: "America/Phoenix", label: "Mountain, no DST (Phoenix)" },
  { value: "America/Los_Angeles", label: "Pacific (Los Angeles)" },
  { value: "America/Anchorage", label: "Alaska (Anchorage)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Honolulu)" },
] as const;
export const TIMEZONES = TIMEZONE_OPTIONS.map((t) => t.value) as [string, ...string[]];
export const timezoneSchema = z.enum(TIMEZONES, "Choose the time zone your business runs on.");

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
    timezone: timezoneSchema,
    /** Flag tickets without a paper/scale ticket number for review (company choice). */
    ticket_reference_required: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
    /** Escalate urgent orders nobody acknowledged within this many minutes; empty = off. */
    urgent_ack_minutes: z.preprocess(
      (v) => (v === "" || v === undefined || v === null ? null : v),
      z.coerce.number().int("Whole minutes.").min(5, "At least 5 minutes.").max(1440, "At most 1440 minutes (24 hours).").nullable(),
    ),
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
  // Internal username sign-in addresses have no mailbox; those accounts are set up by the operator.
  email: z.email("Enter a valid email address.").refine((v) => !isUsernameEmail(v), "This address cannot receive an invitation."),
  full_name: requiredText(120, "Name"),
  role: z.enum(ROLES),
});

export const userAccessSchema = z.object({
  full_name: requiredText(120, "Name"),
  role: z.preprocess((v) => (v === "" ? null : v), z.enum(ROLES).nullable()),
  active: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
});
