import { QuoteEditor } from "@/components/quotes/quote-editor";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/schemas/common";
import { requirePagePermission } from "@/server/auth";
import { loadCustomerContextFor, loadEditorReferenceData, newEditorState } from "@/server/quotes/editor-data";

export const metadata = { title: "New quote" };

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const access = await requirePagePermission("quotes.edit");
  const { customer } = await searchParams;
  const customerId = customer && uuid.safeParse(customer).success ? customer : null;
  const ref = await loadEditorReferenceData();
  const initial = await newEditorState(customerId);
  const context = customerId ? await loadCustomerContextFor(customerId, initial.quoteDate) : null;
  if (context?.customer.tax_exempt) initial.taxRate = "0";
  if (context) {
    const primary = context.contacts.find((c) => c.is_primary) ?? context.contacts[0];
    if (primary) Object.assign(initial, { contactId: primary.id, contactName: primary.name, contactEmail: primary.email, contactPhone: primary.phone });
  }

  return (
    <>
      <PageHeader title="New quote" crumbs={[{ label: "Quotes", href: "/quotes" }, { label: "New" }]} description="The quote number is assigned when you first save." />
      <QuoteEditor
        initial={initial}
        initialContext={context && context.customer.active ? context : null}
        customers={ref.customers}
        materials={ref.materials}
        charges={ref.charges}
        units={ref.units}
        defaultTaxRateBp={ref.settings.default_tax_rate_bp}
        validityDays={ref.settings.quote_validity_days}
        canOverride={can(access, "pricing.override")}
        canEditCustomers={can(access, "customers.edit")}
        priceLists={ref.priceLists}
      />
    </>
  );
}
