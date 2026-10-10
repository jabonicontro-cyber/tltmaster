import { z } from "zod";
import { isIsoDate } from "@/lib/dates";
import { parseMoneyToCents, parsePercentToBp, parseQuantityToMilli } from "@/lib/money";

export const text = (max: number) => z.string().trim().max(max, `Maximum ${max} characters.`).default("");
export const isoDate = z.string().refine(isIsoDate, "Enter a valid date.");
export const optionalUuid = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.uuid().nullable());

export const quoteLineInput = z
  .object({
    kind: z.enum(["material", "hauling", "service", "surcharge", "discount", "other"]),
    calcMethod: z.enum(["per_unit", "percent_of_subtotal"]),
    materialId: optionalUuid,
    chargeItemId: optionalUuid,
    description: z.string().trim().min(1, "Enter a description.").max(300),
    unitCode: z.string().nullable().default(null),
    quantity: z.string().default(""),
    rate: z.string().default(""),
    percent: z.string().default(""),
    taxable: z.boolean().default(false),
  })
  .superRefine((l, ctx) => {
    if (l.materialId && l.chargeItemId) ctx.addIssue({ code: "custom", message: "Choose a material or a charge, not both.", path: ["description"] });
    if (l.materialId && l.kind !== "material") ctx.addIssue({ code: "custom", message: "Material lines must be of type material.", path: ["kind"] });
    if (l.calcMethod === "per_unit") {
      if (!l.unitCode) ctx.addIssue({ code: "custom", message: "Choose a unit.", path: ["unitCode"] });
      const q = parseQuantityToMilli(l.quantity);
      if (q === null || q <= 0 || q > 999_999_999) ctx.addIssue({ code: "custom", message: "Enter a quantity greater than 0 (up to 3 decimals).", path: ["quantity"] });
      const r = parseMoneyToCents(l.rate);
      if (r === null || r < 0 || r > 100_000_000) ctx.addIssue({ code: "custom", message: "Enter a rate like 12.50.", path: ["rate"] });
    } else {
      if (l.kind === "material") ctx.addIssue({ code: "custom", message: "Materials must be priced per unit.", path: ["kind"] });
      const p = parsePercentToBp(l.percent);
      if (p === null || p < 1 || p > 10000) ctx.addIssue({ code: "custom", message: "Enter a percentage between 0.01 and 100.", path: ["percent"] });
    }
  });

/** Contact, job site and job fields shared by quotes and orders. */
export const jobDetailFields = {
  contactId: optionalUuid,
  contactName: text(120),
  contactEmail: text(254).refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email address."),
  contactPhone: text(40),
  siteId: optionalUuid,
  siteLabel: text(120),
  siteLine1: text(200),
  siteLine2: text(200),
  siteCity: text(80),
  siteState: text(2).transform((v) => v.toUpperCase()),
  sitePostalCode: text(10).refine((v) => v === "" || /^\d{5}(-\d{4})?$/.test(v), "Enter a 5-digit ZIP code."),
  saveSite: z.boolean().default(false),
  projectName: text(160),
  customerPo: text(60),
  jobInstructions: text(4000),
  internalNotes: text(4000),
};

export const quoteDraftInput = z
  .object({
    quoteId: optionalUuid,
    expectedEditSeq: z.number().int().nullable().default(null),
    customerId: z.uuid("Choose a customer."),
    ...jobDetailFields,
    quoteDate: isoDate,
    validUntil: isoDate,
    terms: text(8000),
    taxRate: z.string().default("0"),
    lines: z.array(quoteLineInput).max(200, "A quote can have at most 200 lines."),
  })
  .superRefine((q, ctx) => {
    if (q.validUntil < q.quoteDate) ctx.addIssue({ code: "custom", message: "Must be on or after the quote date.", path: ["validUntil"] });
    const bp = parsePercentToBp(q.taxRate || "0");
    if (bp === null || bp > 2500) ctx.addIssue({ code: "custom", message: "Enter a tax rate between 0 and 25.", path: ["taxRate"] });
    if (q.saveSite && !q.siteId && !q.siteLine1) ctx.addIssue({ code: "custom", message: "Enter the street address to save this job site.", path: ["siteLine1"] });
  });

export type QuoteDraftInput = z.input<typeof quoteDraftInput>;
export type QuoteLineInput = z.input<typeof quoteLineInput>;

/** Convert validated editor input to the save_quote_draft() payload. */
export function toSavePayload(q: z.output<typeof quoteDraftInput>) {
  return {
    quote_id: q.quoteId,
    expected_edit_seq: q.expectedEditSeq,
    customer_id: q.customerId,
    contact_id: q.contactId,
    contact_name: q.contactName,
    contact_email: q.contactEmail,
    contact_phone: q.contactPhone,
    site_id: q.siteId,
    site_label: q.siteLabel,
    site_line1: q.siteLine1,
    site_line2: q.siteLine2,
    site_city: q.siteCity,
    site_state: q.siteState,
    site_postal_code: q.sitePostalCode,
    save_site: q.saveSite,
    quote_date: q.quoteDate,
    valid_until: q.validUntil,
    project_name: q.projectName,
    customer_po: q.customerPo,
    job_instructions: q.jobInstructions,
    terms: q.terms,
    internal_notes: q.internalNotes,
    tax_rate_bp: parsePercentToBp(q.taxRate || "0") ?? 0,
    lines: q.lines.map(toLinePayload),
  };
}

/** Database payload of one validated line (save_quote_draft / save_order_draft). */
export function toLinePayload(l: z.output<typeof quoteLineInput>) {
  return {
    kind: l.kind,
    calc_method: l.calcMethod,
    material_id: l.materialId,
    charge_item_id: l.chargeItemId,
    description: l.description,
    unit_code: l.calcMethod === "per_unit" ? l.unitCode : null,
    // quantity as a decimal string; the database stores numeric(12,3)
    quantity: l.calcMethod === "per_unit" ? l.quantity.trim().replace(/,/g, "") : null,
    unit_rate_cents: l.calcMethod === "per_unit" ? parseMoneyToCents(l.rate) : null,
    percent_bp: l.calcMethod === "percent_of_subtotal" ? parsePercentToBp(l.percent) : null,
    taxable: l.taxable,
  };
}

/** Database payload of the shared contact / job-site / job fields. */
export function toJobDetailPayload(q: z.output<z.ZodObject<typeof jobDetailFields>>) {
  return {
    contact_id: q.contactId,
    contact_name: q.contactName,
    contact_email: q.contactEmail,
    contact_phone: q.contactPhone,
    site_id: q.siteId,
    site_label: q.siteLabel,
    site_line1: q.siteLine1,
    site_line2: q.siteLine2,
    site_city: q.siteCity,
    site_state: q.siteState,
    site_postal_code: q.sitePostalCode,
    save_site: q.saveSite,
    project_name: q.projectName,
    customer_po: q.customerPo,
    job_instructions: q.jobInstructions,
    internal_notes: q.internalNotes,
  };
}
