import { z } from "zod";
import { checkbox, optionalEmail, optionalPhone, optionalText, postalCode, requiredText, stateCode } from "./common";

export const customerSchema = z.object({
  name: requiredText(160, "Customer name"),
  customer_type: z.enum(["commercial", "residential"], { error: "Choose commercial or residential." }),
  email: optionalEmail,
  phone: optionalPhone,
  billing_line1: optionalText(200),
  billing_line2: optionalText(200),
  billing_city: optionalText(80),
  billing_state: stateCode,
  billing_postal_code: postalCode,
  po_required: checkbox,
  po_instructions: optionalText(500),
  payment_terms: optionalText(60),
  price_list_id: z.preprocess((v) => (v === "" ? null : v), z.uuid().nullable()),
  tax_exempt: checkbox,
  notes: optionalText(4000),
});

export type CustomerInput = z.infer<typeof customerSchema>;

export const contactSchema = z.object({
  name: requiredText(120, "Contact name"),
  title: optionalText(80),
  email: optionalEmail,
  phone: optionalPhone,
  is_primary: checkbox,
  is_billing: checkbox,
  notes: optionalText(1000),
});

export const siteSchema = z.object({
  label: requiredText(120, "Site name"),
  line1: requiredText(200, "Street address"),
  line2: optionalText(200),
  city: optionalText(80),
  state: stateCode,
  postal_code: postalCode,
  directions: optionalText(2000),
});

export const PAYMENT_TERMS_SUGGESTIONS = ["Due on delivery", "Net 15", "Net 30", "Net 45", "Prepaid"];
