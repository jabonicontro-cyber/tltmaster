import { QuoteEditor } from "@/components/quotes/quote-editor";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/schemas/common";
import { isIsoDate } from "@/lib/dates";
import { requireAnyPagePermission } from "@/server/auth";
import { loadCustomerContextFor, loadEditorReferenceData, newOrderEditorState } from "@/server/quotes/editor-data";
import { getIndustry } from "@/server/industry";

export const metadata = { title: "New order" };

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ customer?: string; date?: string }> }) {
  // orders.create (owner 2026-11-09: dispatchers take phoned-in orders) or orders.edit; the database checks again.
  const access = await requireAnyPagePermission("orders.create", "orders.edit");
  const { customer, date } = await searchParams;
  const customerId = customer && uuid.safeParse(customer).success ? customer : null;
  const ref = await loadEditorReferenceData();
  const initial = await newOrderEditorState(customerId);
  // From the dispatch board ("New order" for the shown day): the requested delivery starts on that day, never earlier
  // than the order date. The person can change it.
  if (date && isIsoDate(date) && date >= initial.quoteDate) initial.requestedDate = date;
  const context = customerId ? await loadCustomerContextFor(customerId, initial.quoteDate) : null;
  if (context?.customer.tax_exempt) initial.taxRate = "0";
  if (context) {
    const primary = context.contacts.find((c) => c.is_primary) ?? context.contacts[0];
    if (primary) Object.assign(initial, { contactId: primary.id, contactName: primary.name, contactEmail: primary.email, contactPhone: primary.phone });
  }

  return (
    <>
      <PageHeader
        title="New order"
        crumbs={[{ label: "Orders", href: "/orders" }, { label: "New" }]}
        description="For work that does not need a quote. The order number is assigned when you first save; the order stays a draft until you confirm it."
      />
      <QuoteEditor
        industry={await getIndustry()}
        mode="order"
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
