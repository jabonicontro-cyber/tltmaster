// Builds the customer-facing quote document (used by both the HTML print
// preview and the PDF). Issued versions use the snapshots captured when they
// were sent, so they always render exactly as the customer received them.
import { formatBp, formatCents, formatQuantity, numericToMilli } from "@/lib/money";
import { formatDateLong } from "@/lib/dates";
import type { CompanySettings, CustomerRow, QuoteLineRow, QuoteRow, QuoteVersionRow } from "@/server/data/types";

export interface QuoteDocument {
  isDraft: boolean;
  quoteNumber: string;
  versionNo: number;
  title: string;
  filename: string;
  company: { name: string; addressLines: string[]; contactLine: string };
  quoteDate: string;
  validUntil: string;
  billTo: { name: string; customerNumber: string; addressLines: string[] };
  contact: { name: string; email: string; phone: string };
  jobSite: { label: string; addressLines: string[] };
  projectName: string;
  customerPo: string;
  paymentTerms: string;
  lines: Array<{ no: number; description: string; quantity: string; unit: string; rate: string; amount: string; isDiscount: boolean }>;
  quantitySummary: Array<{ unit: string; quantity: string }>;
  totals: { subtotal: string; discount: string | null; tax: string | null; taxLabel: string; total: string };
  jobInstructions: string;
  terms: string;
  footerNote: string;
}

function addressLines(line1: string, line2: string, city: string, state: string, postal: string): string[] {
  // A state on its own (the default "IN") is not an address.
  const cityLine = city || postal ? [city, [state, postal].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  return [line1, line2, cityLine].filter((l) => l && l.trim() !== "");
}

export function buildQuoteDocument(args: {
  quote: Pick<QuoteRow, "quote_number">;
  version: QuoteVersionRow;
  lines: QuoteLineRow[];
  customer: CustomerRow;
  settings: CompanySettings;
}): QuoteDocument {
  const { quote, version, lines, customer, settings } = args;
  const isDraft = version.locked_at === null;
  const company = version.company_snapshot ?? {
    company_name: settings.company_name,
    line1: settings.address_line1,
    line2: settings.address_line2,
    city: settings.city,
    state: settings.state,
    postal_code: settings.postal_code,
    phone: settings.phone,
    email: settings.email,
    website: settings.website,
    footer_note: settings.quote_footer_note,
    timezone: settings.timezone,
  };
  const billTo = version.bill_to_snapshot ?? {
    customer_number: customer.customer_number,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    line1: customer.billing_line1,
    line2: customer.billing_line2,
    city: customer.billing_city,
    state: customer.billing_state,
    postal_code: customer.billing_postal_code,
    payment_terms: customer.payment_terms,
  };

  const qtyByUnit = new Map<string, number>();
  const docLines = lines.map((l) => {
    const isDiscount = l.kind === "discount";
    if (l.calc_method === "per_unit") {
      const milli = numericToMilli(l.quantity) ?? 0;
      const unit = l.unit_label || l.unit_code || "";
      if (l.kind === "material") qtyByUnit.set(unit, (qtyByUnit.get(unit) ?? 0) + milli);
      return {
        no: l.line_no,
        description: l.description,
        quantity: formatQuantity(milli),
        unit,
        rate: formatCents(l.unit_rate_cents ?? 0),
        amount: formatCents(l.amount_cents),
        isDiscount,
      };
    }
    return {
      no: l.line_no,
      description: l.description,
      quantity: "",
      unit: "",
      rate: formatBp(l.percent_bp ?? 0),
      amount: formatCents(l.amount_cents),
      isDiscount,
    };
  });

  const contactLine = [company.phone, company.email, company.website].filter(Boolean).join("  ·  ");

  return {
    isDraft,
    quoteNumber: quote.quote_number,
    versionNo: version.version_no,
    title: `Quote ${quote.quote_number}${version.version_no > 1 ? ` (revision ${version.version_no})` : ""}`,
    filename: `${quote.quote_number}-v${version.version_no}${isDraft ? "-DRAFT" : ""}.pdf`,
    company: {
      name: company.company_name,
      addressLines: addressLines(company.line1, company.line2, company.city, company.state, company.postal_code),
      contactLine,
    },
    quoteDate: formatDateLong(version.quote_date),
    validUntil: formatDateLong(version.valid_until),
    billTo: {
      name: billTo.name,
      customerNumber: billTo.customer_number,
      addressLines: addressLines(billTo.line1, billTo.line2, billTo.city, billTo.state, billTo.postal_code),
    },
    contact: { name: version.contact_name, email: version.contact_email, phone: version.contact_phone },
    jobSite: {
      label: version.site_label,
      addressLines: addressLines(version.site_line1, version.site_line2, version.site_city, version.site_state, version.site_postal_code),
    },
    projectName: version.project_name,
    customerPo: version.customer_po,
    paymentTerms: billTo.payment_terms,
    lines: docLines,
    // Quantities are summarized per unit; different units are never added together.
    quantitySummary: [...qtyByUnit.entries()].map(([unit, milli]) => ({ unit, quantity: formatQuantity(milli) })),
    totals: {
      subtotal: formatCents(version.subtotal_cents),
      discount: version.discount_cents > 0 ? `-${formatCents(version.discount_cents)}` : null,
      tax: version.tax_rate_bp > 0 ? formatCents(version.tax_cents) : null,
      taxLabel: `Sales tax (${formatBp(version.tax_rate_bp)})`,
      total: formatCents(version.total_cents),
    },
    jobInstructions: version.job_instructions,
    terms: version.terms,
    footerNote: company.footer_note,
  };
}
