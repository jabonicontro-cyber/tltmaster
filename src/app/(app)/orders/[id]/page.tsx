import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderActions } from "@/components/orders/order-actions";
import { QuoteLinesTable } from "@/components/quotes/quote-lines-table";
import { Badge, OrderStatusBadge, SampleBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatBp, formatCents } from "@/lib/money";
import { buildOrderTimeline } from "@/lib/orders/history";
import { formatScheduleDates, formatTime, formatWindow, isPastRequested } from "@/lib/orders/schedule";
import { canEditOrderLines, ORDER_STATUS_LABELS } from "@/lib/orders/status";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getOrderDispatch } from "@/server/data/dispatch";
import { getOrderDetail } from "@/server/data/orders";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Order" };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("orders.view");
  const { id } = await params;
  const detail = await getOrderDetail(id);
  if (!detail) notFound();
  const { order, customer, lines, events, audit, sourceQuote, sourceVersion, names } = detail;
  const [{ timezone, today }, dispatch] = await Promise.all([businessToday(), getOrderDispatch(id)]);
  const canDispatch = can(access, "dispatch.view");
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "System");
  const billTo = order.bill_to_snapshot;
  const billing = billTo
    ? [billTo.name, billTo.line1, billTo.line2, [billTo.city, billTo.state, billTo.postal_code].filter(Boolean).join(" ")].filter(Boolean).join("\n")
    : customer.name;
  const site = [order.site_label, order.site_line1, order.site_line2, [order.site_city, order.site_state, order.site_postal_code].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join("\n");
  const timeline = buildOrderTimeline(events, audit);
  const linesEditable = canEditOrderLines(order.status, order.source_quote_id);
  const late = isPastRequested(order, today);
  const scheduled = formatScheduleDates(order.scheduled_start, order.scheduled_end);

  return (
    <>
      <PageHeader
        title={order.order_number}
        crumbs={[{ label: "Orders", href: "/orders" }, { label: order.order_number }]}
        badges={
          <>
            <OrderStatusBadge status={order.status} />
            {order.source_quote_id ? <Badge tone="gray">From quote</Badge> : <Badge tone="blue">Direct order</Badge>}
            <SampleBadge show={order.is_sample} />
          </>
        }
        description={
          <>
            <Link href={`/customers/${customer.id}`} className="font-semibold text-ink hover:underline">{customer.name}</Link>
            {order.project_name ? ` · ${order.project_name}` : ""} · Total <strong className="text-ink">{formatCents(order.total_cents)}</strong>
          </>
        }
        actions={
          <OrderActions
            orderId={order.id}
            orderNumber={order.order_number}
            status={order.status}
            sourceQuoteId={order.source_quote_id}
            editSeq={order.edit_seq}
            lineCount={lines.length}
            orderDate={order.order_date}
            schedule={{ start: order.scheduled_start, end: order.scheduled_end, windowStart: order.window_start, windowEnd: order.window_end, notes: order.scheduling_notes }}
            permissions={{ edit: can(access, "orders.edit"), schedule: can(access, "orders.schedule") }}
          />
        }
      />

      <div className="mb-5 space-y-3">
        {(order.status === "on_hold" || order.status === "canceled") && order.status_note && (
          <Notice tone="warning" title={order.status === "canceled" ? "Canceled" : "On hold"}>
            {order.status_note}
          </Notice>
        )}
        {order.status === "draft" && (
          <Notice title="Draft — not confirmed yet">
            Lines, prices and terms can be changed until the order is confirmed. After that they are locked; details and the schedule can still be updated.
          </Notice>
        )}
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
                . Lines, prices, discounts and totals are exactly as accepted and cannot be changed here; the quote itself is unchanged.
              </>
            ) : (
              "This order was created from a quote you do not have permission to view. Its prices are as accepted and cannot be changed."
            )}
          </Notice>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title="Delivery and schedule" description="Truck and driver assignments arrive with dispatch." />
            <CardBody>
              <DescriptionList
                items={[
                  { label: "Order date", value: formatDate(order.order_date) },
                  {
                    label: "Requested delivery",
                    value: order.requested_date ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {formatDate(order.requested_date)}
                        {late && <Badge tone="amber">{order.scheduled_start ? "Scheduled later than requested" : "Requested date passed"}</Badge>}
                      </span>
                    ) : (
                      ""
                    ),
                  },
                  { label: "Scheduled", value: scheduled || <span className="text-muted">Not scheduled yet</span> },
                  { label: "Time window", value: formatWindow(order.window_start, order.window_end) },
                  { label: "Scheduling notes", value: order.scheduling_notes, wide: true },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Loads and assignments"
              description="Planned trips and the truck, trailer and driver assigned to each."
              actions={
                canDispatch && order.scheduled_start ? (
                  <Link href={`/dispatch?date=${dispatch.loads.find((l) => l.status === "planned" && l.load_date >= today)?.load_date ?? order.scheduled_start}`} className="text-sm font-semibold underline">
                    Open dispatch board
                  </Link>
                ) : undefined
              }
            />
            {dispatch.loads.length === 0 ? (
              <CardBody>
                <p className="text-sm text-muted">No loads planned yet{canDispatch ? " — plan them on the dispatch board once the order is scheduled." : "."}</p>
              </CardBody>
            ) : (
              <ul className="divide-y divide-line" aria-label="Loads">
                {dispatch.loads.map((l) => {
                  const a = dispatch.assignments.find((x) => x.load_id === l.id);
                  return (
                    <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 sm:px-5">
                      <span>
                        <strong>Load {l.load_number}</strong>{" "}
                        <span className="text-sm text-muted tabular">
                          {formatDate(l.load_date)}, {formatTime(l.start_time)} – {formatTime(l.end_time)}
                        </span>
                      </span>
                      {l.status === "canceled" ? (
                        <Badge tone="gray">Canceled</Badge>
                      ) : a ? (
                        <span className="text-sm">
                          Truck {dispatch.truckNames.get(a.truck_id) ?? "—"}
                          {a.trailer_id ? ` + ${dispatch.trailerNames.get(a.trailer_id) ?? "trailer"}` : ""} · {dispatch.driverNames.get(a.driver_id) ?? "driver"}
                        </span>
                      ) : (
                        <Badge tone="amber">Needs a truck</Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Customer and job" />
            <CardBody>
              <DescriptionList
                items={[
                  { label: "Customer", value: <Link href={`/customers/${customer.id}`} className="hover:underline">{customer.name} ({customer.customer_number})</Link> },
                  { label: order.source_quote_id ? "Bill to (as accepted)" : "Bill to", value: billing },
                  { label: "Contact", value: [order.contact_name, order.contact_email, order.contact_phone].filter(Boolean).join("\n") },
                  { label: "Job site", value: site },
                  { label: "Project", value: order.project_name },
                  { label: "Customer PO", value: order.customer_po || (customer.po_required ? <Badge tone="amber">Required — not entered</Badge> : "") },
                  { label: "Payment terms", value: billTo?.payment_terms ?? customer.payment_terms },
                  { label: "Created", value: `${formatDateTime(order.created_at, timezone)} by ${who(order.created_by)}` },
                  ...(order.confirmed_at ? [{ label: "Confirmed", value: formatDateTime(order.confirmed_at, timezone) }] : []),
                  ...(order.completed_at ? [{ label: "Completed", value: formatDateTime(order.completed_at, timezone) }] : []),
                  ...(order.canceled_at ? [{ label: "Canceled", value: formatDateTime(order.canceled_at, timezone) }] : []),
                  { label: "Job instructions", value: order.job_instructions, wide: true },
                  { label: "Terms", value: order.terms, wide: true },
                  { label: "Internal notes", value: order.internal_notes, wide: true },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Materials and charges"
              description={
                order.source_quote_id
                  ? "Prices are as accepted on the quote, including any owner-approved overrides and discounts."
                  : linesEditable
                    ? "Draft prices — can be changed until the order is confirmed."
                    : "Prices locked when the order was confirmed."
              }
            />
            {lines.length === 0 ? (
              <CardBody>
                <p className="text-muted">No lines yet.</p>
              </CardBody>
            ) : (
              <QuoteLinesTable lines={lines} />
            )}
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

        <Card className="self-start">
          <CardHeader title="History" description="Status changes and edits, newest first." />
          <ol className="px-4 py-3 sm:px-5" aria-label="Order history">
            {timeline.map((e) => (
              <li key={`${e.kind}-${e.id}`} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
                <span className={`absolute top-1 -left-[5px] size-2 rounded-full ${e.kind === "status" ? "bg-charcoal" : "bg-line"}`} aria-hidden />
                {e.kind === "status" ? (
                  <>
                    <p className="text-sm font-semibold">
                      {e.from ? `${ORDER_STATUS_LABELS[e.from]} → ` : ""}
                      {ORDER_STATUS_LABELS[e.to]}
                    </p>
                    {e.note && <p className="text-sm">{e.note}</p>}
                  </>
                ) : (
                  <>
                    <p className="text-sm font-semibold">{e.summary}</p>
                    {e.changes.length > 0 && (
                      <ul className="mt-0.5 space-y-0.5 text-sm">
                        {e.changes.map((c) => (
                          <li key={c.field}>
                            <span className="text-muted">{c.label}:</span>{" "}
                            {c.from !== null ? (
                              <>
                                <span className="line-through decoration-muted">{c.from}</span> → {c.to}
                              </>
                            ) : (
                              "changed"
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                <p className="text-xs text-muted">{formatDateTime(e.at, timezone)} · {who(e.actorId)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
