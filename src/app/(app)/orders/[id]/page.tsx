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
import { liveTicketsForLoads, orderLineTickets } from "@/server/data/tickets";
import { lineProgress } from "@/lib/tickets/context";
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { trimNumber } from "@/lib/fleet/labels";
import { getOrderDetail } from "@/server/data/orders";
import { getOrderReadiness } from "@/server/data/billing";
import { getOrderUrgency } from "@/server/data/urgency";
import { OrderProgress } from "@/components/orders/order-progress";
import { UrgencyPanel } from "@/components/orders/urgency-panel";
import { ReturnLink } from "@/components/ui/return-link";
import { orderProgress } from "@/lib/orders/progress";
import { businessToday, getSettings } from "@/server/data/settings";
import { DirectionsRiskBadge, DirectionsStatusBadge } from "@/components/sites/directions-status";
import { directionsStatus } from "@/lib/sites";

export const metadata = { title: "Order" };

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ back?: string }> }) {
  const access = await requirePagePermission("orders.view");
  const { id } = await params;
  const { back } = await searchParams;
  const detail = await getOrderDetail(id);
  if (!detail) notFound();
  const { order, customer, lines, events, audit, sourceQuote, sourceVersion, names, site: savedSite } = detail;
  const [{ timezone, today }, dispatch] = await Promise.all([businessToday(), getOrderDispatch(id)]);
  const [loadTickets, readiness, urgency] = await Promise.all([
    liveTicketsForLoads(dispatch.loads.map((l) => l.id)),
    can(access, "billing.view") ? getOrderReadiness(id) : Promise.resolve(null),
    getOrderUrgency(id),
  ]);
  const lineTickets = can(access, "tickets.view") && order.status !== "draft" ? await orderLineTickets(id) : null;
  const now = new Date();
  const plannedLoads = dispatch.loads.filter((l) => l.status === "planned");
  const completionCheck = {
    loadsStillToRun: plannedLoads.filter((l) => new Date(l.ends_at) > now).length,
    loadsWithoutTicket: plannedLoads.filter((l) => new Date(l.ends_at) <= now && !loadTickets.some((t) => t.load_id === l.id)).length,
    ticketsAwaitingReview: loadTickets.filter((t) => t.status === "submitted" || t.status === "needs_review").length,
  };
  const canDispatch = can(access, "dispatch.view");
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "System");
  const billTo = order.bill_to_snapshot;
  const billing = billTo
    ? [billTo.name, billTo.line1, billTo.line2, [billTo.city, billTo.state, billTo.postal_code].filter(Boolean).join(" ")].filter(Boolean).join("\n")
    : customer.name;
  const site = [order.site_label, order.site_line1, order.site_line2, [order.site_city, order.site_state, order.site_postal_code].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join("\n");
  // Directions verification of the saved site (B51; absent before 20261115000200 is installed).
  const settings = savedSite?.directions_risk ? await getSettings() : null;
  const siteRisk = savedSite?.directions_risk ?? "standard";
  const siteDirections = savedSite?.directions_risk && settings
    ? directionsStatus(
        { directions: savedSite.directions, directions_risk: siteRisk, directions_verified_at: savedSite.directions_verified_at ?? null },
        { site_review_days_standard: settings.site_review_days_standard ?? null, site_review_days_safety: settings.site_review_days_safety ?? null },
      )
    : null;
  const timeline = buildOrderTimeline(events, audit);
  const linesEditable = canEditOrderLines(order.status, order.source_quote_id);
  const late = isPastRequested(order, today);
  const scheduled = formatScheduleDates(order.scheduled_start, order.scheduled_end);
  const progress = orderProgress({
    orderId: order.id,
    orderStatus: order.status,
    loads: dispatch.loads.map((l) => ({
      id: l.id,
      status: l.status,
      load_date: l.load_date,
      ends_at: l.ends_at,
      assigned: dispatch.assignments.some((a) => a.load_id === l.id && a.status === "active"),
      tickets: loadTickets.filter((t) => t.load_id === l.id).map((t) => ({ id: t.id, status: t.status })),
    })),
    billing: readiness,
    now: new Date(),
  });

  return (
    <>
      <ReturnLink back={back} />
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
            completionCheck={completionCheck}
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

      <div className="mb-5 space-y-5">
        {urgency && (
          <UrgencyPanel
            orderId={order.id}
            orderClosed={order.status === "completed" || order.status === "canceled"}
            open={urgency.open}
            events={urgency.events}
            permissions={access.permissions}
            names={names}
            timezone={timezone}
            today={today}
            now={new Date().toISOString()}
          />
        )}
        {order.status !== "draft" && <OrderProgress steps={progress} />}
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
                  <span className="flex flex-wrap items-center gap-3">
                    {can(access, "dispatch.edit") && ["scheduled", "dispatched", "in_progress", "partially_completed"].includes(order.status) && (
                      <Link href={`/orders/${order.id}/load-build`} className="text-sm font-semibold text-brand-fg underline">
                        Build loads
                      </Link>
                    )}
                    <Link href={`/dispatch?date=${dispatch.loads.find((l) => l.status === "planned" && l.load_date >= today)?.load_date ?? order.scheduled_start}`} className="text-sm font-semibold underline">
                      Open dispatch board
                    </Link>
                  </span>
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
                      {loadTickets
                        .filter((t) => t.load_id === l.id)
                        .map((t) => (
                          <Link key={t.id} href={`/tickets/${t.id}`} className="flex w-full items-center justify-end gap-2 text-sm hover:underline">
                            <span className="font-semibold tabular">{t.ticket_number}</span>
                            <span className="tabular">{trimNumber(t.quantity)} {t.unit_code}</span>
                            <TicketStatusBadge status={t.status} />
                          </Link>
                        ))}
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
                  {
                    label: "Job site",
                    value: siteDirections && siteDirections !== "none" ? (
                      <>
                        {site}
                        <span className="mt-1 flex flex-wrap gap-1.5">
                          <DirectionsRiskBadge risk={siteRisk} />
                          <DirectionsStatusBadge status={siteDirections} risk={siteRisk} />
                        </span>
                      </>
                    ) : (
                      site
                    ),
                  },
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
            {lineTickets && lines.length > 0 && (
              <div className="border-t border-line px-4 py-3 sm:px-5">
                <h3 className="mb-2 text-sm font-bold text-ink">Delivered so far</h3>
                <table className="w-full text-sm" aria-label="Delivered so far">
                  <thead>
                    <tr className="text-left text-xs text-muted uppercase">
                      <th className="py-1 font-semibold">Line</th>
                      <th className="py-1 text-right font-semibold">Ordered</th>
                      <th className="py-1 text-right font-semibold">Verified</th>
                      <th className="hidden py-1 text-right font-semibold sm:table-cell">Awaiting review</th>
                      <th className="py-1 text-right font-semibold">Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.filter((ln) => ln.unit_code && ln.quantity !== null).map((ln) => {
                      const p = lineProgress({ unit_code: ln.unit_code!, quantity: ln.quantity! }, lineTickets.filter((t) => t.order_line_id === ln.id), "");
                      return (
                        <tr key={ln.id} className="border-t border-line">
                          <td className="py-1.5">{ln.description}</td>
                          <td className="py-1.5 text-right tabular">{p.ordered} {ln.unit_code}</td>
                          <td className="py-1.5 text-right tabular">{p.verifiedOthers}</td>
                          <td className="hidden py-1.5 text-right tabular sm:table-cell">{p.pendingOthers}</td>
                          <td className={p.over ? "py-1.5 text-right font-semibold text-brand-fg tabular" : "py-1.5 text-right tabular"}>{p.over ? `${p.remainingAfterThis.replace("-", "")} over` : p.remainingAfterThis}{p.otherUnitTickets ? ` (+${p.otherUnitTickets} in another unit)` : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-1 text-xs text-muted">From delivery tickets in each line&apos;s unit. Only verified (accepted) tickets count as delivered; prices are not changed by deliveries.</p>
              </div>
            )}
            <div className="flex justify-end border-t border-line px-4 py-3 sm:px-5">
              <dl className="w-full max-w-xs space-y-1 text-[15px]">
                <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{formatCents(order.subtotal_cents)}</dd></div>
                {order.discount_cents > 0 && (
                  <div className="flex justify-between"><dt className="text-muted">Discounts</dt><dd className="text-green-800 tabular">-{formatCents(order.discount_cents)}</dd></div>
                )}
                <div className="flex justify-between"><dt className="text-muted">Tax ({formatBp(order.tax_rate_bp)})</dt><dd className="tabular">{formatCents(order.tax_cents)}</dd></div>
                <div className="flex justify-between border-t-2 border-strong pt-1 text-lg font-black"><dt>Total</dt><dd className="tabular">{formatCents(order.total_cents)}</dd></div>
              </dl>
            </div>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader title="History" description="Status changes and edits, newest first." />
          <ol className="px-4 py-3 sm:px-5" aria-label="Order history">
            {timeline.map((e) => (
              <li key={`${e.kind}-${e.id}`} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
                <span className={`absolute top-1 -left-[5px] size-2 rounded-full ${e.kind === "status" ? "bg-strong" : "bg-line"}`} aria-hidden />
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
