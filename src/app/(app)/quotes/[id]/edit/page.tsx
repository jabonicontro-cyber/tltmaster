import { notFound, redirect } from "next/navigation";
import { QuoteEditor } from "@/components/quotes/quote-editor";
import { QuoteStatusBadge, SampleBadge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getQuoteDetail } from "@/server/data/quotes";
import { editorStateFromVersion, loadCustomerContextFor, loadEditorReferenceData } from "@/server/quotes/editor-data";

export const metadata = { title: "Edit quote" };

export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("quotes.edit");
  const { id } = await params;
  const detail = await getQuoteDetail(id);
  if (!detail) notFound();
  const { quote, current, lines } = detail;
  // Issued versions are read-only; send the user to the quote page to revise.
  if (quote.status !== "draft" || current.locked_at) redirect(`/quotes/${id}`);

  const [ref, context] = await Promise.all([loadEditorReferenceData(), loadCustomerContextFor(quote.customer_id, current.quote_date)]);
  const customers = ref.customers.some((c) => c.id === quote.customer_id)
    ? ref.customers
    : [...ref.customers, { id: detail.customer.id, name: detail.customer.name, customer_number: detail.customer.customer_number, customer_type: detail.customer.customer_type, is_sample: detail.customer.is_sample, tax_exempt: detail.customer.tax_exempt, active: detail.customer.active }];

  return (
    <>
      <PageHeader
        title={`Edit ${quote.quote_number}`}
        crumbs={[{ label: "Quotes", href: "/quotes" }, { label: quote.quote_number, href: `/quotes/${id}` }, { label: "Edit" }]}
        badges={
          <>
            <QuoteStatusBadge status={quote.status} />
            {current.version_no > 1 && <span className="text-sm font-semibold text-muted">Revision {current.version_no}</span>}
            <SampleBadge show={quote.is_sample} />
          </>
        }
      />
      <QuoteEditor
        initial={editorStateFromVersion(quote, current, lines)}
        initialContext={context}
        customers={customers}
        materials={ref.materials}
        charges={ref.charges}
        units={ref.units}
        defaultTaxRateBp={ref.settings.default_tax_rate_bp}
        validityDays={ref.settings.quote_validity_days}
        canOverride={can(access, "pricing.override")}
        canEditCustomers={can(access, "customers.edit")}
        priceLists={ref.priceLists}
        revisionReason={current.version_no > 1 ? current.revision_reason : undefined}
      />
    </>
  );
}
