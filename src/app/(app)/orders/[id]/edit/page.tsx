import { notFound, redirect } from "next/navigation";
import { OrderDetailsForm } from "@/components/orders/order-details-form";
import { QuoteEditor } from "@/components/quotes/quote-editor";
import { Badge, OrderStatusBadge, SampleBadge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { canEditOrderDetails, canEditOrderLines } from "@/lib/orders/status";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getCustomerQuoteContext } from "@/server/data/customers";
import { getOrderDetail } from "@/server/data/orders";
import { editorStateFromOrder, loadCustomerContextFor, loadEditorReferenceData } from "@/server/quotes/editor-data";

export const metadata = { title: "Edit order" };

export default async function EditOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("orders.edit");
  const { id } = await params;
  const detail = await getOrderDetail(id);
  if (!detail) notFound();
  const { order, lines, customer } = detail;
  if (!canEditOrderDetails(order.status)) redirect(`/orders/${id}`);

  const header = (
    <PageHeader
      title={`Edit ${order.order_number}`}
      crumbs={[{ label: "Orders", href: "/orders" }, { label: order.order_number, href: `/orders/${id}` }, { label: "Edit" }]}
      badges={
        <>
          <OrderStatusBadge status={order.status} />
          {order.source_quote_id ? <Badge tone="gray">From quote</Badge> : <Badge tone="blue">Direct order</Badge>}
          <SampleBadge show={order.is_sample} />
        </>
      }
    />
  );

  // Direct order in Draft: full editor (customer, lines, prices).
  if (canEditOrderLines(order.status, order.source_quote_id)) {
    const [ref, context] = await Promise.all([loadEditorReferenceData(), loadCustomerContextFor(order.customer_id, order.order_date)]);
    const customers = ref.customers.some((c) => c.id === order.customer_id)
      ? ref.customers
      : [...ref.customers, { id: customer.id, name: customer.name, customer_number: customer.customer_number, customer_type: customer.customer_type, is_sample: customer.is_sample, tax_exempt: customer.tax_exempt, active: customer.active }];
    return (
      <>
        {header}
        <QuoteEditor
          mode="order"
          initial={editorStateFromOrder(order, lines)}
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
        />
      </>
    );
  }

  // Confirmed or quote-linked: details only. Prices, lines and terms stay as they are.
  const context = await getCustomerQuoteContext(order.customer_id);
  return (
    <>
      {header}
      <OrderDetailsForm
        order={{
          id: order.id,
          editSeq: order.edit_seq,
          orderDate: order.order_date,
          fromQuote: Boolean(order.source_quote_id),
          contactId: order.contact_id ?? "",
          contactName: order.contact_name,
          contactEmail: order.contact_email,
          contactPhone: order.contact_phone,
          siteId: order.site_id ?? (order.site_line1 ? "new" : ""),
          siteLabel: order.site_label,
          siteLine1: order.site_line1,
          siteLine2: order.site_line2,
          siteCity: order.site_city,
          siteState: order.site_state || "IN",
          sitePostalCode: order.site_postal_code,
          projectName: order.project_name,
          customerPo: order.customer_po,
          jobInstructions: order.job_instructions,
          internalNotes: order.internal_notes,
          requestedDate: order.requested_date ?? "",
        }}
        customer={{ name: customer.name, poRequired: customer.po_required, poInstructions: customer.po_instructions }}
        contacts={context?.contacts ?? []}
        sites={context?.sites ?? []}
        canEditCustomers={can(access, "customers.edit")}
      />
    </>
  );
}
