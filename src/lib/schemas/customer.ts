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
  // Missing (the short form inside a quote has no price list field) means none, as an empty choice does.
  price_list_id: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.uuid().nullable()),
  tax_exempt: checkbox,
  notes: optionalText(4000),
  // Freight brokers (MK2, 20261120009600): the broker is invoiced; its MC number is digits only ("MC-123456" → "123456").
  is_broker: checkbox,
  mc_number: z.preprocess((v) => String(v ?? "").replace(/^\s*mc[\s#:-]*/i, "").replace(/[\s-]/g, ""), z.string().regex(/^[0-9]{0,8}$/, { error: "An MC number is up to 8 digits." })),
});

/** The broker fields, left out when saving to a database that does not have them yet (before 20261120009600). */
export const withoutBrokerFields = <T extends Record<string, unknown>>(row: T) => {
  const { is_broker: _b, mc_number: _m, ...rest } = row;
  void _b; void _m;
  return rest;
};

export type CustomerInput = z.infer<typeof customerSchema>;

/** Who may set a customer's money fields (financial review L4, 20261120016200; the database checks the same). */
export interface CustomerMoneyAccess {
  /** pricing.edit: the customer's price list and sales tax exemption. */
  pricing: boolean;
  /** billing.manage: payment terms (and detention, on the customer page). */
  billing: boolean;
}

/**
 * Leaves out the money fields this person may not set, so a saved customer keeps its value and a new one gets the
 * default (no price list, taxed, no payment terms).
 */
export function withoutLockedMoneyFields<T extends Record<string, unknown>>(row: T, may: CustomerMoneyAccess): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  if (!may.pricing) {
    delete out.price_list_id;
    delete out.tax_exempt;
  }
  if (!may.billing) delete out.payment_terms;
  return out;
}

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
  /** Sent only once directions verification (20261115000200) is installed. */
  directions_risk: z.enum(["standard", "safety_access"], { error: "Choose how critical these directions are." }).optional(),
});

export const PAYMENT_TERMS_SUGGESTIONS = ["Due on delivery", "Net 15", "Net 30", "Net 45", "Prepaid"];
