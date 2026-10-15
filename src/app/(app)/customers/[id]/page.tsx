import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FileText, Pencil, Plus } from "lucide-react";
import { ArchiveCustomerButton, ContactsPanel, SitesPanel } from "@/components/customers/customer-panels";
import { QuoteTable } from "@/components/quotes/quote-table";
import { ActiveBadge, Badge, SampleBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { FlashToast } from "@/components/ui/flash-toast";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getCustomerDetail } from "@/server/data/customers";
import { businessToday, getSettings } from "@/server/data/settings";
import { getUserNames } from "@/server/data/quotes";
import { directionsStatus } from "@/lib/sites";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("customers.view");
  const { id } = await params;
  const detail = await getCustomerDetail(id);
  if (!detail) notFound();
  const { customer, contacts, sites, quotes } = detail;
  const { today, timezone } = await businessToday();
  const canEdit = can(access, "customers.edit");
  // Directions verification (20261115000200): only once that update is installed.
  const settings = await getSettings();
  const verification = "site_review_days_standard" in settings;
  const userNames = verification && sites.some((s) => s.directions_verified_by) ? await getUserNames() : {};
  const intervals = { site_review_days_standard: settings.site_review_days_standard ?? null, site_review_days_safety: settings.site_review_days_safety ?? null };
  const siteViews = sites.map((s) => ({
    ...s,
    verification: verification
      ? {
          risk: s.directions_risk ?? "standard",
          status: directionsStatus({ directions: s.directions, directions_risk: s.directions_risk ?? "standard", directions_verified_at: s.directions_verified_at ?? null }, intervals),
          verifiedAt: s.directions_verified_at ? formatDateTime(s.directions_verified_at, timezone) : null,
          verifiedBy: s.directions_verified_by ? userNames[s.directions_verified_by] ?? "Former user" : null,
        }
      : null,
  }));
  const billing = [
    customer.billing_line1,
    customer.billing_line2,
    [customer.billing_city, customer.billing_state, customer.billing_postal_code].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      <Suspense>
        <FlashToast
          messages={{
            created: { text: "Customer created." },
            saved: { text: "Customer saved." },
            contact: { text: "Customer saved, but the contact could not be added. Add it below.", tone: "warning" },
          }}
        />
      </Suspense>
      <PageHeader
        title={customer.name}
        crumbs={[{ label: "Customers", href: "/customers" }, { label: customer.customer_number }]}
        badges={
          <>
            <ActiveBadge active={customer.active} />
            <SampleBadge show={customer.is_sample} />
          </>
        }
        description={`${customer.customer_number} · ${customer.customer_type === "commercial" ? "Commercial" : "Residential"} customer`}
        actions={
          <>
            {can(access, "quotes.edit") && customer.active && (
              <ButtonLink href={`/quotes/new?customer=${customer.id}`} icon={<Plus className="size-4" />}>
                New quote
              </ButtonLink>
            )}
            {can(access, "orders.edit") && customer.active && (
              <ButtonLink href={`/orders/new?customer=${customer.id}`} variant="secondary" icon={<Plus className="size-4" />}>
                New order
              </ButtonLink>
            )}
            {canEdit && (
              <ButtonLink href={`/customers/${customer.id}/edit`} variant="secondary" icon={<Pencil className="size-4" />}>
                Edit
              </ButtonLink>
            )}
            {canEdit && <ArchiveCustomerButton customerId={customer.id} active={customer.active} name={customer.name} />}
          </>
        }
      />

      {!customer.active && (
        <div className="mb-4">
          <Notice tone="warning" title="Archived customer">
            This customer is archived. Reactivate to create new quotes.
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DescriptionList
                items={[
                  { label: "Main email", value: customer.email },
                  { label: "Main phone", value: customer.phone },
                  { label: "Billing address", value: billing },
                  { label: "Payment terms", value: customer.payment_terms },
                  {
                    label: "Purchase orders",
                    value: customer.po_required ? (
                      <span>
                        <Badge tone="blue">PO required</Badge> {customer.po_instructions}
                      </span>
                    ) : (
                      "Not required"
                    ),
                  },
                  { label: "Pricing", value: customer.price_lists?.name ?? "Standard rates" },
                  { label: "Sales tax", value: customer.tax_exempt ? "Tax exempt" : "Taxable" },
                  { label: "Last updated", value: formatDateTime(customer.updated_at, timezone) },
                  { label: "Internal notes", value: customer.notes, wide: true },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Quotes" description="Most recent 50 quotes for this customer." />
            {quotes.length === 0 ? (
              <EmptyState
                icon={<FileText className="size-6" />}
                title="No quotes yet"
                action={
                  can(access, "quotes.edit") && customer.active ? (
                    <ButtonLink href={`/quotes/new?customer=${customer.id}`} size="sm">
                      Create a quote
                    </ButtonLink>
                  ) : undefined
                }
                className="py-8"
              />
            ) : (
              <QuoteTable rows={quotes} today={today} showCustomer={false} />
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <ContactsPanel customerId={customer.id} contacts={contacts} canEdit={canEdit} />
          <SitesPanel customerId={customer.id} sites={siteViews} canEdit={canEdit} verification={verification} />
        </div>
      </div>
    </>
  );
}
