import { describe, expect, it } from "vitest";
import { buildQuoteDocument } from "@/lib/quotes/document";
import type { CompanySettings, CustomerRow, QuoteLineRow, QuoteVersionRow } from "@/server/data/types";

const settings = {
  company_name: "Top Line Trucking", address_line1: "", address_line2: "", city: "", state: "IN", postal_code: "",
  phone: "(219) 555-0000", email: "", website: "", timezone: "America/Chicago", default_tax_rate_bp: 0,
  quote_validity_days: 30, quote_followup_days: 3, default_quote_terms: "", quote_footer_note: "Thanks", urgent_ack_minutes: null, ticket_reference_required: true, updated_at: "",
} satisfies CompanySettings;

const customer = {
  id: "c1", customer_number: "C-00001", name: "Live Name LLC", customer_type: "commercial", email: "", phone: "",
  billing_line1: "1 Live St", billing_line2: "", billing_city: "Gary", billing_state: "IN", billing_postal_code: "46401",
  po_required: false, po_instructions: "", payment_terms: "Net 30", price_list_id: null, tax_exempt: false, notes: "",
  active: true, is_sample: true, created_at: "", updated_at: "",
} satisfies CustomerRow;

function version(overrides: Partial<QuoteVersionRow> = {}): QuoteVersionRow {
  return {
    id: "v1", quote_id: "q1", version_no: 2, edit_seq: 1, contact_id: null, contact_name: "Pat", contact_email: "", contact_phone: "",
    site_id: null, site_label: "Yard", site_line1: "5 Site Rd", site_line2: "", site_city: "Hebron", site_state: "IN", site_postal_code: "",
    quote_date: "2026-10-01", valid_until: "2026-10-31", project_name: "", customer_po: "PO-9", job_instructions: "", terms: "Terms",
    internal_notes: "secret", tax_rate_bp: 700, subtotal_cents: 33750, discount_cents: 0, taxable_cents: 22500, tax_cents: 1575,
    total_cents: 35325, revision_reason: "", locked_at: null, sent_at: null, bill_to_snapshot: null, company_snapshot: null,
    created_at: "", updated_at: "", ...overrides,
  };
}

const lines: QuoteLineRow[] = [
  { id: "l1", quote_version_id: "v1", line_no: 1, kind: "material", calc_method: "per_unit", material_id: "m", charge_item_id: null, description: "Gravel", unit_code: "ton", unit_label: "Tons", quantity: "22.500", unit_rate_cents: 1000, percent_bp: null, catalog_rate_cents: 1000, catalog_percent_bp: null, price_source: "standard", taxable: true, amount_cents: 22500 },
  { id: "l2", quote_version_id: "v1", line_no: 2, kind: "material", calc_method: "per_unit", material_id: "m2", charge_item_id: null, description: "Topsoil", unit_code: "cu_yd", unit_label: "Cubic yards", quantity: "10.000", unit_rate_cents: 2500, percent_bp: null, catalog_rate_cents: null, catalog_percent_bp: null, price_source: "manual", taxable: true, amount_cents: 25000 },
  { id: "l3", quote_version_id: "v1", line_no: 3, kind: "surcharge", calc_method: "percent_of_subtotal", material_id: null, charge_item_id: "c", description: "Fuel", unit_code: null, unit_label: "", quantity: null, unit_rate_cents: null, percent_bp: 500, catalog_rate_cents: null, catalog_percent_bp: 500, price_source: "standard", taxable: false, amount_cents: 2375 },
];

describe("buildQuoteDocument", () => {
  it("renders a draft from live data and never includes internal notes", () => {
    const doc = buildQuoteDocument({ quote: { quote_number: "Q-2026-0001" }, version: version(), lines, customer, settings });
    expect(doc.isDraft).toBe(true);
    expect(doc.filename).toBe("Q-2026-0001-v2-DRAFT.pdf");
    expect(doc.billTo.name).toBe("Live Name LLC");
    expect(doc.company.addressLines).toEqual([]); // a lone default state is not an address
    expect(JSON.stringify(doc)).not.toContain("secret");
    expect(doc.lines[0]).toMatchObject({ quantity: "22.5", unit: "Tons", rate: "$10.00", amount: "$225.00" });
    expect(doc.lines[2]).toMatchObject({ rate: "5%", quantity: "" });
    expect(doc.totals).toEqual({ subtotal: "$337.50", discount: null, tax: "$15.75", taxLabel: "Sales tax (7%)", total: "$353.25" });
  });

  it("keeps quantities in different units separate", () => {
    const doc = buildQuoteDocument({ quote: { quote_number: "Q" }, version: version(), lines, customer, settings });
    expect(doc.quantitySummary).toEqual([
      { unit: "Tons", quantity: "22.5" },
      { unit: "Cubic yards", quantity: "10" },
    ]);
  });

  it("uses the snapshots of an issued version even if the customer changed later", () => {
    const issued = version({
      locked_at: "2026-10-02T15:00:00Z",
      bill_to_snapshot: { customer_number: "C-00001", name: "Name When Sent", email: "", phone: "", line1: "9 Old Rd", line2: "", city: "Gary", state: "IN", postal_code: "46401", payment_terms: "Net 15" },
      company_snapshot: { company_name: "Top Line Trucking", line1: "", line2: "", city: "", state: "", postal_code: "", phone: "", email: "", website: "", footer_note: "", timezone: "America/Chicago" },
    });
    const doc = buildQuoteDocument({ quote: { quote_number: "Q" }, version: issued, lines, customer, settings });
    expect(doc.isDraft).toBe(false);
    expect(doc.billTo.name).toBe("Name When Sent");
    expect(doc.paymentTerms).toBe("Net 15");
    expect(doc.footerNote).toBe("");
  });
});
