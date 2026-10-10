import Link from "next/link";
import { ReturnLink } from "@/components/ui/return-link";
import { notFound } from "next/navigation";
import { ClipboardList, FilePlus2 } from "lucide-react";
import { AcknowledgeButton, RevertHandoffButton } from "@/components/billing/decision-buttons";
import { ExceptionTable } from "@/components/billing/exception-table";
import { ReadinessBadge } from "@/components/billing/readiness-badge";
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { QUANTITY_CHECK_LABELS, QUANTITY_POLICY, formatDifference, readinessExplanation } from "@/lib/billing/rules";
import { formatDate, formatDateTime } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";
import { formatTime } from "@/lib/orders/schedule";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getOrderBilling } from "@/server/data/billing";

export const metadata = { title: "Order billing" };

const qty = (v: number | string | null | undefined) => (v === null || v === undefined ? "—" : trimNumber(v));

const LOAD_STATE: Record<string, { label: string; tone: "red" | "amber" | "green" | "gray" }> = {
  missing: { label: "Missing ticket", tone: "red" },
  needs_review: { label: "Ticket to review", tone: "amber" },
  documented: { label: "Documented", tone: "green" },
  not_due: { label: "Not delivered yet", tone: "gray" },
};

export default async function OrderBillingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ back?: string }> }) {
  const { back } = await searchParams;
  const access = await requirePagePermission("billing.view");
  const { id } = await params;
  const data = await getOrderBilling(id);
  if (!data) notFound();
  const { status: o, loads, lines, exceptions, reviews, handoffs, tickets, names, people, timezone } = data;
  const e = readinessExplanation(o.readiness, o);
  const canManage = can(access, "billing.manage");
  const canEnterTickets = can(access, "tickets.edit");
  const ticketsOf = (pred: (t: (typeof tickets)[number]) => boolean) => tickets.filter(pred);
  const person = (uid: string | null) => people[uid ?? ""] ?? "Someone";

  return (
    <>
      <ReturnLink back={back} />
      <PageHeader
        crumbs={[{ label: "Billing", href: "/billing" }, { label: o.order_number }]}
        title={`Billing — ${o.order_number}`}
        description={`${o.customer_name ?? ""}${o.project_name ? ` · ${o.project_name}` : ""}${o.customer_po ? ` · PO ${o.customer_po}` : ""}`}
        badges={<ReadinessBadge readiness={o.readiness} />}
        actions={<ButtonLink href={`/orders/${o.order_id}`} variant="secondary" icon={<ClipboardList className="size-4" />}>Open order</ButtonLink>}
      />

      <div className="space-y-5">
        <Notice tone={o.readiness === "ready" || o.readiness === "handed_off" ? "info" : "warning"} title={e.why}>
          {e.action}
          {o.readiness === "handed_off" && (
            <> Batch {o.batch_number}{o.handoff_reference ? ` (${o.handoff_reference})` : ""}, {formatDateTime(o.handed_off_at, timezone)} by {person(o.handed_off_by)}.</>
          )}
          {o.changed_since_handoff && <strong> Tickets changed after the handoff — check the invoice in your accounting system.</strong>}
        </Notice>

        <Card>
          <CardHeader title="Loads" description="Planned against delivered, from the current ticket revisions. Voided and replaced revisions do not count." />
          {loads.length === 0 ? (
            <CardBody><p className="text-sm text-muted">No planned loads.</p></CardBody>
          ) : (
            <TableWrap>
              <Table aria-label="Loads">
                <thead>
                  <tr>
                    <Th>Load</Th>
                    <Th>Tickets</Th>
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
                          <span className="font-semibold">Load {l.load_number}</span> <Badge tone={st.tone}>{st.label}</Badge>
                          <div className="text-sm text-muted tabular">{formatDate(l.load_date)}, {formatTime(l.start_time)} – {formatTime(l.end_time)}</div>
                          <div className="text-sm text-muted">{l.truck_id ? `${names.trucks.get(l.truck_id) ?? "—"} · ${l.driver_id ? names.drivers.get(l.driver_id) ?? "—" : "—"}` : "Not assigned"}</div>
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
                            <ButtonLink href={`/tickets/new?load=${l.load_id}`} size="sm" className="mt-1" icon={<FilePlus2 className="size-4" />}>Enter ticket</ButtonLink>
                          )}
                        </Td>
                        <Td align="right" className="tabular">{l.planned_quantity !== null ? `${qty(l.planned_quantity)} ${l.planned_unit_code}` : "—"}</Td>
                        <Td align="right" className="tabular">{l.delivered_quantity !== null ? `${qty(l.delivered_quantity)} ${l.planned_unit_code}` : l.live_count ? `in ${(l.ticket_units ?? []).join(", ")}` : "—"}</Td>
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

        <Card>
          <CardHeader title="Order lines" description="Prices are the order's accepted prices and are never recalculated here. Delivered = live tickets for the line in the line's unit." />
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
                    <Td align="right" className="tabular">{l.delivered_quantity !== null ? `${qty(l.delivered_quantity)} ${l.unit_code}` : l.live_count ? `in ${(l.ticket_units ?? []).join(", ")}` : "—"}</Td>
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

        <Card>
          <CardHeader
            title={`Exceptions (${o.exceptions_count})`}
            description={QUANTITY_POLICY}
            actions={canManage && o.readiness === "blocked" ? (
              <AcknowledgeButton orderId={o.order_id} orderNumber={o.order_number} fingerprint={o.exceptions_fingerprint} count={o.exceptions_count} />
            ) : undefined}
          />
          {exceptions.length === 0 ? (
            <CardBody><p className="text-sm text-muted">No exceptions.</p></CardBody>
          ) : (
            <>
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
                      {r.fingerprint !== o.exceptions_fingerprint && <Badge tone="gray" className="ml-2">No longer current — exceptions changed</Badge>}
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
