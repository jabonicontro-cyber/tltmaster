import Link from "next/link";
import type { ReactNode } from "react";
import { vocabulary } from "@/lib/industry";
import { getSettings } from "@/server/data/settings";
import { ReturnLink } from "@/components/ui/return-link";
import { notFound } from "next/navigation";
import { CalendarRange, ClipboardCheck, ClipboardList, FilePlus2 } from "lucide-react";
import { AcknowledgeButton, RevertHandoffButton } from "@/components/billing/decision-buttons";
import { ExceptionTable } from "@/components/billing/exception-table";
import { InvoiceDraftCard } from "@/components/billing/invoice-draft";
import { ReadinessBadge } from "@/components/billing/readiness-badge";
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { QUANTITY_CHECK_LABELS, QUANTITY_POLICY, formatDifference, readinessExplanation, sayExplanation } from "@/lib/billing/rules";
import { formatDate, formatDateTime } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";
import { formatTime } from "@/lib/orders/schedule";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getOrderBilling } from "@/server/data/billing";
import { getSay } from "@/server/industry";
import { DetentionCard, type DetentionRow } from "@/components/billing/detention-card";
import { createClient } from "@/server/supabase/server";
import { ExtraChargeForm } from "@/components/billing/extra-charge-form";
import { TruckHoursCard, type TruckHours } from "@/components/billing/truck-hours-card";
import { HandOffOne } from "@/components/billing/hand-off-form";
import { invoicesByHandoff, invoicingSettings } from "@/server/data/invoices";
import { CompleteOrderButton } from "@/components/billing/complete-order";
import { acknowledgementChange, billingBlockers, completionSteps, type Blocker } from "@/lib/billing/blockers";
import { buttonClasses } from "@/components/ui/button";
import { createInvoice } from "@/app/(app)/billing/invoices/actions";
import type { OrderStatus } from "@/server/data/types";

export const metadata = { title: "Order billing" };

const qty = (v: number | string | null | undefined) => (v === null || v === undefined ? "–" : trimNumber(v));

const LOAD_STATE: Record<string, { label: string; tone: "red" | "amber" | "green" | "gray" }> = {
  missing: { label: "Missing ticket", tone: "red" },
  needs_review: { label: "Ticket to review", tone: "amber" },
  documented: { label: "Documented", tone: "green" },
  not_due: { label: "Not delivered yet", tone: "gray" },
};

export default async function OrderBillingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ back?: string }> }) {
  const say = await getSay();
  // Ticket or BOL wording (MK1): from the company's What you haul.
  const words = vocabulary((await getSettings().catch(() => null))?.industry);
  const { back } = await searchParams;
  const access = await requirePagePermission("billing.view");
  const { id } = await params;
  const data = await getOrderBilling(id);
  if (!data) notFound();
  const { draft, status: o, loads, lines, exceptions, reviews, handoffs, tickets, names, people, timezone, editSeq } = data;
  const canManage = can(access, "billing.manage");
  const canEnterTickets = can(access, "tickets.edit");
  // Who issues invoices decides the next step after the handoff (Taviron: create the invoice; else accounting).
  const invoicing = await invoicingSettings().catch(() => null);
  const issuer = invoicing?.installed ? invoicing.issuer : null;
  const e = sayExplanation(readinessExplanation(o.readiness, o, issuer), say);
  const handoffInvoice = issuer === "taviron" && o.readiness === "handed_off" && o.handoff_order_id ? (await invoicesByHandoff([o.handoff_order_id]))[o.handoff_order_id] ?? null : null;
  // Everything that still blocks billing, at once; an acknowledgement that stopped counting says why.
  const lastReview = reviews[0];
  const ackChange = !o.acknowledgment_id && o.exceptions_count > 0 && lastReview && lastReview.fingerprint !== o.exceptions_fingerprint
    ? acknowledgementChange(lastReview.exceptions, exceptions)
    : null;
  const missingLoads = loads.filter((l) => l.documentation_state === "missing");
  const blockers = billingBlockers(o, { unassignedMissing: missingLoads.filter((l) => !l.assignment_id).length, ackChange });
  const steps = can(access, "orders.schedule") && editSeq !== null ? completionSteps(o.status as OrderStatus) : null;
  const completeFacts = [
    o.loads_not_due > 0 && `${o.loads_not_due} planned load(s) have not run yet.`,
    o.loads_missing > 0 && `${o.loads_missing} delivered load(s) have no delivery ticket.`,
    o.tickets_pending > 0 && `${o.tickets_pending} ticket(s) are not accepted yet.`,
  ].filter((f): f is string => Boolean(f));
  const pendingTickets = tickets.filter((t) => t.status === "submitted" || t.status === "needs_review");
  const ticketsOf = (pred: (t: (typeof tickets)[number]) => boolean) => tickets.filter(pred);
  const person = (uid: string | null) => people[uid ?? ""] ?? "Someone";
  // Detention proposals (DT1, 20261120008200): none before the migration or when the customer has no detention set.
  const detention = await (await createClient()).rpc("detention_proposals", { p_order: id });
  const detentionRows = (detention.error ? [] : detention.data ?? []) as DetentionRow[];
  // Truck-day orders (UX11): truck-hours from the company's setting; absent before 20261120008600.
  const truckHoursRes = await (await createClient()).rpc("truck_day_hours", { p_order: id });
  const truckHours = truckHoursRes.error ? null : (truckHoursRes.data as TruckHours);
  // Extra charges (MK2): the company's active charges billed per occurrence; none before 20261120008200.
  const extras = canManage && o.readiness !== "handed_off" && !["draft", "canceled"].includes(String(o.status ?? ""))
    ? await (await createClient()).from("charge_items").select("id, name, default_unit_code").eq("active", true).eq("ticket_required", false).eq("calc_method", "per_unit").order("name")
    : null;
  const extraOptions = ((extras && !extras.error ? extras.data : []) ?? []).map((c) => ({ id: c.id as string, name: c.name as string, unit: String(c.default_unit_code ?? "") }));

  return (
    <>
      <ReturnLink back={back} />
      <PageHeader
        crumbs={[{ label: "Billing", href: "/billing" }, { label: o.order_number }]}
        title={`Billing · ${o.order_number}`}
        description={`${o.customer_name ?? ""}${o.project_name ? ` · ${o.project_name}` : ""}${o.customer_po ? ` · PO ${o.customer_po}` : ""}`}
        badges={<ReadinessBadge readiness={o.readiness} />}
        actions={<>
          <ButtonLink href={`/orders/${o.order_id}`} variant="secondary" icon={<ClipboardList className="size-4" />}>Open order</ButtonLink>
          {canManage && o.readiness === "ready" && <HandOffOne orderId={o.order_id} orderNumber={o.order_number} taviron={issuer === "taviron"} />}
        </>}
      />

      <div className="space-y-5">
        {blockers.length > 0 ? (
          <Card>
            <CardHeader
              title={blockers.length === 1 ? "One thing keeps this order out of billing" : `${blockers.length} things keep this order out of billing`}
              description="Everything at once, with what to do for each. The order is ready to bill when this list is empty."
            />
            <ul className="divide-y divide-line border-t border-line" aria-label="What blocks billing">
              {blockers.map((b) => (
                <li key={b.key} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 sm:px-6">
                  <div className="min-w-0 max-w-2xl">
                    <p className="font-semibold">{say(b.title)}</p>
                    <p className="text-sm text-muted">{say(b.detail)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <BlockerAction
                      blocker={b}
                      enterHref={canEnterTickets && missingLoads.length === 1 && missingLoads[0].assignment_id ? `/tickets/new?load=${missingLoads[0].load_id}` : null}
                      enterLabel={words.enter}
                      dispatchHref={can(access, "dispatch.view") ? `/dispatch?date=${missingLoads.find((l) => !l.assignment_id)?.load_date ?? ""}` : null}
                      reviewHref={pendingTickets.length ? `/tickets/${pendingTickets[0].id}?queue=review` : null}
                      exceptions={canManage && b.actionable && o.exceptions_count > 0 && !o.acknowledgment_id ? (
                        <AcknowledgeButton size="sm" orderId={o.order_id} orderNumber={o.order_number} fingerprint={o.exceptions_fingerprint} count={o.exceptions_count} />
                      ) : null}
                      complete={steps && steps.length > 0 ? (
                        <CompleteOrderButton orderId={o.order_id} orderNumber={o.order_number} status={o.status as OrderStatus} editSeq={editSeq!} steps={steps} facts={completeFacts} />
                      ) : null}
                      orderHref={`/orders/${o.order_id}`}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Notice tone={o.readiness === "ready" || o.readiness === "handed_off" ? "info" : "warning"} title={e.why}>
            {e.action}
            {o.readiness === "handed_off" && (
              <> Batch {o.batch_number}{o.handoff_reference ? ` (${o.handoff_reference})` : ""}, {formatDateTime(o.handed_off_at, timezone)} by {person(o.handed_off_by)}.</>
            )}
            {o.changed_since_handoff && <strong>{say(issuer === "taviron" ? " Tickets changed after the handoff: check the invoice." : " Tickets changed after the handoff: check the invoice in your accounting system.")}</strong>}
            {issuer === "taviron" && o.readiness === "handed_off" && o.handoff_order_id && (
              <div className="mt-2 flex flex-wrap gap-2">
                {handoffInvoice ? (
                  <Link href={`/billing/invoices/${handoffInvoice.id}`} className={buttonClasses("primary", "sm")}>
                    {handoffInvoice.number ? `Open invoice ${handoffInvoice.number}` : "Open the draft invoice"}
                  </Link>
                ) : canManage ? (
                  <form action={createInvoice}>
                    <input type="hidden" name="handoff" value={o.handoff_order_id} />
                    <input type="hidden" name="back" value={`/billing/orders/${o.order_id}`} />
                    <button type="submit" className={buttonClasses("primary", "sm")}><FilePlus2 className="size-4" aria-hidden />Create the invoice</button>
                  </form>
                ) : null}
              </div>
            )}
          </Notice>
        )}

        <div id="loads" className="scroll-mt-24">
        <Card>
          <CardHeader title="Loads" description={say("Planned against delivered, from the current ticket revisions. Voided and replaced revisions do not count.")} />
          {loads.length === 0 ? (
            <CardBody><p className="text-sm text-muted">No planned loads.</p></CardBody>
          ) : (
            <TableWrap>
              <Table aria-label="Loads">
                <thead>
                  <tr>
                    <Th>Load</Th>
                    <Th>{say("Tickets")}</Th>
                    <Th align="right">Planned</Th>
                    <Th align="right">Delivered</Th>
                    <Th className="hidden sm:table-cell">Comparison</Th>
                  </tr>
                </thead>
                <tbody>
                  {loads.map((l) => {
                    const st = LOAD_STATE[l.documentation_state];
                    const lt = ticketsOf((t) => t.load_id === l.load_id);
                    return (
                      <Tr key={l.load_id}>
                        <Td>
                          <span className="font-semibold">Load {l.load_number}</span> <Badge tone={st.tone}>{say(st.label)}</Badge>
                          <div className="text-sm text-muted tabular">{formatDate(l.load_date)}, {formatTime(l.start_time)} – {formatTime(l.end_time)}</div>
                          <div className="text-sm text-muted">{l.truck_id ? `${names.trucks.get(l.truck_id) ?? "–"} · ${l.driver_id ? names.drivers.get(l.driver_id) ?? "–" : "–"}` : "Not assigned"}</div>
                        </Td>
                        <Td>
                          {lt.length === 0 && <span className="text-sm text-muted">None</span>}
                          <ul className="space-y-1">
                            {lt.map((t) => (
                              <li key={t.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                                <Link href={`/tickets/${t.id}`} className="font-semibold tabular hover:underline">{t.ticket_number}</Link>
                                <span className="tabular">{qty(t.quantity)} {t.unit_code}</span>
                                <TicketStatusBadge status={t.status} />
                              </li>
                            ))}
                          </ul>
                          {l.documentation_state === "missing" && l.assignment_id && canEnterTickets && (
                            <ButtonLink href={`/tickets/new?load=${l.load_id}`} size="sm" className="mt-1" icon={<FilePlus2 className="size-4" />}>{words.enter}</ButtonLink>
                          )}
                          {l.documentation_state === "missing" && !l.assignment_id && (
                            <p className="mt-1 max-w-64 text-xs text-muted">No truck was assigned, so no ticket can be entered. Dispatch assigns it (or cancels the load if it did not run).</p>
                          )}
                        </Td>
                        <Td align="right" className="tabular">{l.planned_quantity !== null ? `${qty(l.planned_quantity)} ${l.planned_unit_code}` : "–"}</Td>
                        <Td align="right" className="tabular">{l.delivered_quantity !== null ? `${qty(l.delivered_quantity)} ${l.planned_unit_code}` : l.live_count ? `in ${(l.ticket_units ?? []).join(", ")}` : "–"}</Td>
                        <Td className="hidden sm:table-cell text-sm">
                          {QUANTITY_CHECK_LABELS[l.quantity_check]}
                          {l.quantity_difference !== null && l.quantity_check !== "match" && <span className="font-semibold tabular"> ({formatDifference(l.quantity_difference)})</span>}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
        </div>

        {extraOptions.length > 0 && <ExtraChargeForm orderId={id} options={extraOptions} />}
        {truckHours?.job_type === "truck_day" && <TruckHoursCard data={truckHours} timeZone={timezone} orderId={id} canManage={canManage} locked={o.readiness === "handed_off"} />}
        {detentionRows.length > 0 && <DetentionCard orderId={id} rows={detentionRows} canManage={canManage} locked={o.readiness === "handed_off"} />}

        <Card>
          <CardHeader title="Order lines" description={say("Prices are the order's accepted prices and are never recalculated here. Delivered = live tickets for the line in the line's unit.")} />
          <TableWrap>
            <Table aria-label="Order lines">
              <thead>
                <tr>
                  <Th>Line</Th>
                  <Th align="right">Ordered</Th>
                  <Th align="right">Delivered</Th>
                  <Th className="hidden sm:table-cell">Comparison</Th>
                  <Th align="right" className="hidden md:table-cell">Rate · amount</Th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <Tr key={l.line_id}>
                    <Td>
                      <span className="text-muted">{l.line_no}.</span> {l.description}
                      {l.pending_count > 0 && <div className="text-xs text-muted">{l.pending_count} ticket(s) not accepted yet</div>}
                    </Td>
                    <Td align="right" className="tabular">{qty(l.ordered_quantity)} {l.unit_code}</Td>
                    <Td align="right" className="tabular">{l.delivered_quantity !== null ? `${qty(l.delivered_quantity)} ${l.unit_code}` : l.live_count ? `in ${(l.ticket_units ?? []).join(", ")}` : "–"}</Td>
                    <Td className="hidden sm:table-cell text-sm">
                      {QUANTITY_CHECK_LABELS[l.quantity_check]}
                      {l.quantity_difference !== null && !["match", "in_progress"].includes(l.quantity_check) && <span className="font-semibold tabular"> ({formatDifference(l.quantity_difference)})</span>}
                      {l.pricing_check === "zero_rate" && <div className="text-amber-900">Rate is $0.00</div>}
                    </Td>
                    <Td align="right" className="hidden md:table-cell tabular">{formatCents(l.unit_rate_cents)} · {formatCents(l.amount_cents)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
          <CardBody className="border-t border-line text-sm">
            Order total <span className="font-semibold tabular">{formatCents(o.total_cents)}</span> (as accepted; includes any percentage charges, discounts and tax).
          </CardBody>
        </Card>

        <InvoiceDraftCard draft={draft} />

        <Card>
          <CardHeader
            title={`Exceptions (${o.exceptions_count})`}
            description={say(QUANTITY_POLICY)}
            actions={canManage && o.readiness === "blocked" ? (
              <AcknowledgeButton orderId={o.order_id} orderNumber={o.order_number} fingerprint={o.exceptions_fingerprint} count={o.exceptions_count} />
            ) : undefined}
          />
          {exceptions.length === 0 ? (
            <CardBody><p className="text-sm text-muted">No exceptions.</p></CardBody>
          ) : (
            <>
              {ackChange && (
                <CardBody className="border-b border-line text-sm">
                  <Badge tone="amber">Acknowledge again</Badge> {ackChange}
                </CardBody>
              )}
              {o.acknowledgment_id && (
                <CardBody className="border-b border-line text-sm">
                  <Badge tone="green">Acknowledged</Badge> by {person(o.acknowledged_by)} on {formatDateTime(o.acknowledged_at, timezone)}: “{o.acknowledgment_reason}”
                </CardBody>
              )}
              <ExceptionTable rows={exceptions} />
            </>
          )}
        </Card>

        <Card>
          <CardHeader title="Billing history" description="Office decisions on this order. Nothing is deleted." />
          <CardBody>
            {reviews.length === 0 && handoffs.length === 0 ? (
              <p className="text-sm text-muted">No billing decisions yet.</p>
            ) : (
              <ul className="space-y-3" aria-label="Billing history">
                {handoffs.map((h) => (
                  <li key={h.id} className="text-sm">
                    <div className="font-semibold">
                      Handed off in batch {h.batch.batch_number}{h.batch.reference ? ` (${h.batch.reference})` : ""}
                      {h.reverted_at && <Badge tone="gray" className="ml-2">Undone</Badge>}
                    </div>
                    <div className="text-muted">{person(h.batch.created_by)} · {formatDateTime(h.batch.created_at, timezone)}</div>
                    {h.reverted_at && <div className="text-muted">Undone by {person(h.reverted_by)} on {formatDateTime(h.reverted_at, timezone)}: {h.revert_reason}</div>}
                    {!h.reverted_at && canManage && (
                      <RevertHandoffButton handoffOrderId={h.id} orderId={o.order_id} orderNumber={o.order_number} batchNumber={h.batch.batch_number} />
                    )}
                  </li>
                ))}
                {reviews.map((r) => (
                  <li key={r.id} className="text-sm">
                    <div className="font-semibold">
                      Exceptions acknowledged ({r.exceptions.length})
                      {r.fingerprint !== o.exceptions_fingerprint && <Badge tone="gray" className="ml-2">No longer current: the differences changed</Badge>}
                    </div>
                    <div className="text-muted">{person(r.decided_by)} · {formatDateTime(r.decided_at, timezone)}: “{r.reason}”</div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/** The one action for a blocker, where the person may take it; otherwise where to go. */
function BlockerAction({ blocker, enterHref, enterLabel, dispatchHref, reviewHref, exceptions, complete, orderHref }: {
  blocker: Blocker; enterHref: string | null; enterLabel: string; dispatchHref: string | null; reviewHref: string | null;
  exceptions: ReactNode; complete: ReactNode; orderHref: string;
}) {
  switch (blocker.key) {
    case "missing_tickets":
      return enterHref
        ? <ButtonLink href={enterHref} size="sm" icon={<FilePlus2 className="size-4" />}>{enterLabel}</ButtonLink>
        : <a href="#loads" className={buttonClasses("secondary", "sm")}>Go to the loads</a>;
    case "unassigned_loads":
      return dispatchHref ? <ButtonLink href={dispatchHref} size="sm" variant="secondary" icon={<CalendarRange className="size-4" />}>Open dispatch</ButtonLink> : <span className="text-sm text-muted">For dispatch</span>;
    case "no_tickets":
      return <a href="#loads" className={buttonClasses("secondary", "sm")}>Go to the loads</a>;
    case "tickets_to_check":
      return reviewHref ? <ButtonLink href={reviewHref} size="sm" icon={<ClipboardCheck className="size-4" />}>Check the tickets</ButtonLink> : null;
    case "not_completed":
      return complete ?? <ButtonLink href={orderHref} size="sm" variant="secondary" icon={<ClipboardList className="size-4" />}>Open the order</ButtonLink>;
    case "exceptions":
      return exceptions ?? (blocker.actionable ? null : <span className="text-sm text-muted">After completing</span>);
  }
}
