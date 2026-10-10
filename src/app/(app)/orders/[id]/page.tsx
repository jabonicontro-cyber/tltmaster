import Link from "next/link";
import { notFound } from "next/navigation";
import { QuoteLinesTable } from "@/components/quotes/quote-lines-table";
import { Badge, OrderStatusBadge, SampleBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { formatDateTime } from "@/lib/dates";
import { formatBp, formatCents } from "@/lib/money";
import { ORDER_STATUS_LABELS } from "@/lib/orders/status";
import { requirePagePermission } from "@/server/auth";
import { getOrderDetail } from "@/server/data/orders";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Order" };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePagePermission("orders.view");
  const { id } = await params;
  const detail = await getOrderDetail(id);
  if (!detail) notFound();
  const { order, customer, lines, events, sourceQuote, sourceVersion, names } = detail;
  const { timezone } = await businessToday();
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "System");
  const billTo = order.bill_to_snapshot;
  const billing = billTo
    ? [billTo.name, billTo.line1, billTo.line2, [billTo.city, billTo.state, billTo.postal_code].filter(Boolean).join(" ")].filter(Boolean).join("\n")
    : customer.name;
  const site = [order.site_label, order.site_line1, order.site_line2, [order.site_city, order.site_state, order.site_postal_code].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      <PageHeader
        title={order.order_number}
        crumbs={[{ label: "Orders", href: "/orders" }, { label: order.order_number }]}
        badges={
          <>
            <OrderStatusBadge status={order.status} />
            <SampleBadge show={order.is_sample} />
          </>
        }
        description={
          <>
            <Link href={`/customers/${customer.id}`} className="font-semibold text-ink hover:underline">{customer.name}</Link>
            {order.project_name ? ` · ${order.project_name}` : ""} · Total <strong className="text-ink">{formatCents(order.total_cents)}</strong>
          </>
        }
      />

      <div className="mb-5 space-y-3">
        {order.source_quote_id && (
          <Notice title="Created from an accepted quote">
            {sourceQuote ? (
              <>
                Source: <Link href={`/quotes/${sourceQuote.id}`} className="font-semibold underline">{sourceQuote.quote_number}</Link>
                {sourceVersion && (
                  <>
                    {" "}— revision{" "}
                    <Link href={`/quotes/${sourceQuote.id}/versions/${sourceVersion.id}`} className="underline">{sourceVersion.version_no}</Link>
                  </>
                )}
                . Customer, job site, lines, prices, discounts and totals were copied from that revision; the quote itself is unchanged.
              </>
            ) : (
              "This order was created from a quote you do not have permission to view."
            )}
          </Notice>
        )}
        <Notice tone="warning" title="Scheduling is not available yet">
          Delivery dates, truck and driver assignments, and delivery tickets for this order arrive with the dispatch and tickets work.
        </Notice>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DescriptionList
                items={[
                  { label: "Customer", value: <Link href={`/customers/${customer.id}`} className="hover:underline">{customer.name} ({customer.customer_number})</Link> },
                  { label: "Bill to (as accepted)", value: billing },
                  { label: "Contact", value: [order.contact_name, order.contact_email, order.contact_phone].filter(Boolean).join("\n") },
                  { label: "Job site", value: site },
                  { label: "Project", value: order.project_name },
                  { label: "Customer PO", value: order.customer_po || (customer.po_required ? <Badge tone="amber">Required — not entered</Badge> : "") },
                  { label: "Payment terms", value: billTo?.payment_terms ?? customer.payment_terms },
                  { label: "Created", value: `${formatDateTime(order.created_at, timezone)} by ${who(order.created_by)}` },
                  { label: "Job instructions", value: order.job_instructions, wide: true },
                  { label: "Terms", value: order.terms, wide: true },
                  { label: "Internal notes", value: order.internal_notes, wide: true },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Line items" description="Prices are as accepted on the quote, including any owner-approved overrides and discounts." />
            <QuoteLinesTable lines={lines} />
            <div className="flex justify-end border-t border-line px-4 py-3 sm:px-5">
              <dl className="w-full max-w-xs space-y-1 text-[15px]">
                <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{formatCents(order.subtotal_cents)}</dd></div>
                {order.discount_cents > 0 && (
                  <div className="flex justify-between"><dt className="text-muted">Discounts</dt><dd className="text-green-800 tabular">-{formatCents(order.discount_cents)}</dd></div>
                )}
                <div className="flex justify-between"><dt className="text-muted">Tax ({formatBp(order.tax_rate_bp)})</dt><dd className="tabular">{formatCents(order.tax_cents)}</dd></div>
                <div className="flex justify-between border-t-2 border-charcoal pt-1 text-lg font-black"><dt>Total</dt><dd className="tabular">{formatCents(order.total_cents)}</dd></div>
              </dl>
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader title="History" />
          <ol className="px-4 py-3 sm:px-5">
            {events.map((e) => (
              <li key={e.id} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
                <span className="absolute top-1 -left-[5px] size-2 rounded-full bg-charcoal" aria-hidden />
                <p className="text-sm font-semibold">
                  {e.from_status ? `${ORDER_STATUS_LABELS[e.from_status]} → ` : ""}
                  {ORDER_STATUS_LABELS[e.to_status]}
                </p>
                {e.note && <p className="text-sm">{e.note}</p>}
                <p className="text-xs text-muted">{formatDateTime(e.occurred_at, timezone)} · {who(e.actor_id)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
