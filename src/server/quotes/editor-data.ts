import "server-only";
import { addDays } from "@/lib/dates";
import { bpToInput, centsToInput, milliToInput, numericToMilli } from "@/lib/money";
import type { CustomerContext, EditorState } from "@/components/quotes/quote-editor";
import { listChargeItems, listMaterials, listPriceLists, listUnits } from "@/server/data/catalog";
import { getCustomerQuoteContext, listCustomerOptions } from "@/server/data/customers";
import { businessToday, getSettings } from "@/server/data/settings";
import { createClient } from "@/server/supabase/server";
import type { EffectivePrice, OrderLineRow, OrderRow, QuoteLineRow, QuoteVersionRow } from "@/server/data/types";

export async function loadEditorReferenceData() {
  const [customers, materials, charges, units, settings, priceLists] = await Promise.all([
    listCustomerOptions(),
    listMaterials({ includeInactive: true }),
    listChargeItems({ includeInactive: true }),
    listUnits(),
    getSettings(),
    listPriceLists(),
  ]);
  return { customers, materials, charges, units, settings, priceLists: priceLists.filter((p) => !p.is_standard) };
}

export async function loadCustomerContextFor(customerId: string, onDate: string): Promise<CustomerContext | null> {
  const ctx = await getCustomerQuoteContext(customerId);
  if (!ctx) return null;
  const supabase = await createClient();
  const { data } = await supabase.rpc("effective_prices", { p_customer_id: customerId, p_on: onDate });
  return { ...ctx, prices: (data ?? []) as EffectivePrice[] };
}

export async function newEditorState(customerId: string | null): Promise<EditorState> {
  const settings = await getSettings();
  const { today } = await businessToday();
  return {
    quoteId: null,
    quoteNumber: null,
    versionNo: 1,
    editSeq: null,
    customerId: customerId ?? "",
    contactId: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    siteId: "",
    siteLabel: "",
    siteLine1: "",
    siteLine2: "",
    siteCity: "",
    siteState: "IN",
    sitePostalCode: "",
    saveSite: false,
    quoteDate: today,
    validUntil: addDays(today, settings.quote_validity_days),
    projectName: "",
    customerPo: "",
    jobInstructions: "",
    terms: settings.default_quote_terms,
    internalNotes: "",
    taxRate: bpToInput(settings.default_tax_rate_bp) || "0",
    lines: [],
  };
}

type EditorSource = Pick<
  QuoteVersionRow,
  | "version_no" | "edit_seq" | "contact_id" | "contact_name" | "contact_email" | "contact_phone" | "site_id" | "site_label" | "site_line1"
  | "site_line2" | "site_city" | "site_state" | "site_postal_code" | "quote_date" | "valid_until" | "project_name" | "customer_po"
  | "job_instructions" | "terms" | "internal_notes" | "tax_rate_bp"
>;

export function editorStateFromVersion(quote: { id: string; quote_number: string; customer_id: string }, v: EditorSource, lines: Array<Omit<QuoteLineRow, "quote_version_id">>): EditorState {
  return {
    quoteId: quote.id,
    quoteNumber: quote.quote_number,
    versionNo: v.version_no,
    editSeq: v.edit_seq,
    customerId: quote.customer_id,
    contactId: v.contact_id ?? "",
    contactName: v.contact_name,
    contactEmail: v.contact_email,
    contactPhone: v.contact_phone,
    siteId: v.site_id ?? (v.site_line1 ? "new" : ""),
    siteLabel: v.site_label,
    siteLine1: v.site_line1,
    siteLine2: v.site_line2,
    siteCity: v.site_city,
    siteState: v.site_state || "IN",
    sitePostalCode: v.site_postal_code,
    saveSite: false,
    quoteDate: v.quote_date,
    validUntil: v.valid_until,
    projectName: v.project_name,
    customerPo: v.customer_po,
    jobInstructions: v.job_instructions,
    terms: v.terms,
    internalNotes: v.internal_notes,
    taxRate: bpToInput(v.tax_rate_bp) || "0",
    lines: lines.map((l) => ({
      key: l.id,
      kind: l.kind,
      calcMethod: l.calc_method,
      materialId: l.material_id,
      chargeItemId: l.charge_item_id,
      description: l.description,
      unitCode: l.unit_code,
      quantity: milliToInput(numericToMilli(l.quantity)),
      rate: centsToInput(l.unit_rate_cents),
      percent: bpToInput(l.percent_bp),
      taxable: l.taxable,
      isCustom: l.kind !== "material" && !l.charge_item_id,
    })),
  };
}

/** Editor state for a new direct order (no quote). */
export async function newOrderEditorState(customerId: string | null): Promise<EditorState> {
  const state = await newEditorState(customerId);
  // Quote terms talk about the quote's expiration; direct orders start without terms.
  return { ...state, validUntil: state.quoteDate, requestedDate: "", terms: "" };
}

/** Editor state for a direct order in Draft. */
export function editorStateFromOrder(o: OrderRow, lines: OrderLineRow[]): EditorState {
  const fromVersion = editorStateFromVersion(
    { id: o.id, quote_number: o.order_number, customer_id: o.customer_id },
    { ...o, version_no: 1, quote_date: o.order_date, valid_until: o.order_date },
    lines,
  );
  return { ...fromVersion, requestedDate: o.requested_date ?? "" };
}
