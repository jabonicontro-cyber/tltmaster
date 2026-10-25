import Link from "next/link";
import { DateInput } from "@/components/ui/date-input";
import { CalendarRange, CheckCircle2, ChevronRight, Download, FilePlus2 } from "lucide-react";
import { AcknowledgeButton, RevertHandoffButton } from "@/components/billing/decision-buttons";
import { ExceptionTable } from "@/components/billing/exception-table";
import { HandOffForm } from "@/components/billing/hand-off-form";
import { QuickBooksSendButton, QuickBooksStatus } from "@/components/billing/quickbooks-send";
import { ReadinessBadge } from "@/components/billing/readiness-badge";
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";

import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  EXCEPTION_KINDS, EXCEPTION_LABELS, QUANTITY_POLICY, READINESS, READINESS_LABELS, readinessExplanation,
} from "@/lib/billing/rules";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime, isIsoDate } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";
import { formatTime } from "@/lib/orders/schedule";
import { can } from "@/lib/permissions";
import { reviewReasonLabel } from "@/lib/tickets/rules";
import { requirePagePermission } from "@/server/auth";
import { getQuickBooksForHandoffs } from "@/server/data/accounting";
import { BILLING_VIEWS, getBillingBoard, type BillingFilters, type BillingView } from "@/server/data/billing";

export const metadata = { title: "Billing Readiness" };

type Search = { view?: string; q?: string; from?: string; to?: string; customer?: string; kind?: string; readiness?: string; batch?: string };


function serviceDates(a: string | null, b: string | null) {
  if (!a) return "—";
  return b && b !== a ? `${formatDate(a)} – ${formatDate(b)}` : formatDate(a);
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("billing.view");
  const sp = await searchParams;
  const view: BillingView = sp.view && sp.view in BILLING_VIEWS ? (sp.view as BillingView) : "orders";
  const filters: BillingFilters = {
    q: sp.q,
    from: sp.from && isIsoDate(sp.from) ? sp.from : undefined,
    to: sp.to && isIsoDate(sp.to) ? sp.to : undefined,
    customer: sp.customer || undefined,
    kind: sp.kind && (EXCEPTION_KINDS as readonly string[]).includes(sp.kind) ? sp.kind : undefined,
    readiness: sp.readiness && (READINESS as readonly string[]).includes(sp.readiness) ? sp.readiness : undefined,
  };
  const canManage = can(access, "billing.manage");
  const canEnterTickets = can(access, "tickets.edit");
  const board = await getBillingBoard(view, filters);
  const keep = (k: BillingView) => {
    const p = new URLSearchParams({ view: k });
    for (const f of ["q", "from", "to", "customer"] as const) if (filters[f]) p.set(f, filters[f]!);
    return `/billing?${p}`;
  };

  return (
    <>
      <PageHeader
        title="Billing Readiness"
        description="Which delivered work is documented, reviewed and ready to invoice. Handed-off orders go to your accounting system by file or, once connected, by Send to QuickBooks. Nothing here changes prices or marks anything paid."
        actions={<ButtonLink href="/billing/setup" variant="secondary" size="sm">Businesses and QuickBooks</ButtonLink>}
      />
      <nav aria-label="Billing views" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {(Object.keys(BILLING_VIEWS) as BillingView[]).map((k) => (
          <Link
            key={k}
            href={keep(k)}
            aria-current={k === view ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[15px] font-semibold whitespace-nowrap",
              k === view ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {BILLING_VIEWS[k]}
            {board.counts[k] ? <Badge tone="gray">{board.counts[k]}</Badge> : null}
          </Link>
        ))}
      </nav>

      <Card>
        <FilterBar action="/billing" query={sp.q} placeholder="Search order #, customer, PO, project…" clearHref={`/billing?view=${view}`}>
          <input type="hidden" name="view" value={view} />
          <div>
            <label htmlFor="f-from" className="mb-1 block text-xs font-medium text-muted">Service from</label>
            <DateInput id="f-from" name="from" defaultValue={filters.from} className="w-40" />
          </div>
          <div>
            <label htmlFor="f-to" className="mb-1 block text-xs font-medium text-muted">To</label>
            <DateInput id="f-to" name="to" defaultValue={filters.to} className="w-40" />
          </div>
          <FilterSelect name="customer" label="Customer" value={filters.customer} options={[{ value: "", label: "All customers" }, ...board.customers.map((c) => ({ value: c.id, label: c.name }))]} />
          {view === "orders" && (
            <FilterSelect name="readiness" label="Status" value={filters.readiness} options={[{ value: "", label: "Any status" }, ...READINESS.filter((r) => r !== "handed_off").map((r) => ({ value: r, label: READINESS_LABELS[r] }))]} />
          )}
          {view === "exceptions" && (
            <FilterSelect name="kind" label="Exception" value={filters.kind} options={[{ value: "", label: "All exceptions" }, ...EXCEPTION_KINDS.map((k) => ({ value: k, label: EXCEPTION_LABELS[k] }))]} />
          )}
        </FilterBar>

        {board.view === "orders" || board.view === "ready" ? (
          board.orders.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="size-6" />}
              title={board.view === "ready" ? "No orders are ready to bill" : "No orders match"}
              description={board.view === "ready" ? "An order is ready when it is completed, every load has an accepted ticket and every exception is acknowledged." : "Scheduled, in-progress and completed orders appear here with what still blocks billing."}
            />
          ) : board.view === "ready" ? (
            <HandOffForm orders={board.orders} canManage={canManage} />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th className="hidden sm:table-cell">Service dates</Th>
                    <Th>Status</Th>
                    <Th className="hidden md:table-cell">Reason</Th>
                    <Th className="hidden lg:table-cell">Next step</Th>
                  </tr>
                </thead>
                <tbody>
                  {board.orders.map((o) => {
                    const e = readinessExplanation(o.readiness, o);
                    return (
                      <Tr key={o.order_id}>
                        <Td>
                          <Link href={`/billing/orders/${o.order_id}`} className="font-semibold tabular hover:underline">{o.order_number}</Link>
                          <div className="text-sm text-muted">{o.customer_name}{o.project_name ? ` · ${o.project_name}` : ""}</div>
                        </Td>
                        <Td className="hidden whitespace-nowrap sm:table-cell tabular">{serviceDates(o.service_start, o.service_end)}</Td>
                        <Td>
                          <ReadinessBadge readiness={o.readiness} />
                          <div className="mt-1 text-xs text-muted md:hidden">{e.why}</div>
                        </Td>
                        <Td className="hidden max-w-md text-sm text-pretty md:table-cell">
                          {e.why}
                          <div className="mt-0.5 text-muted lg:hidden">Next: {e.next}</div>
                        </Td>
                        <Td className="hidden text-sm whitespace-nowrap text-muted lg:table-cell">
                          <Link href={`/billing/orders/${o.order_id}`} className="inline-flex items-center gap-1 font-medium text-brand-fg hover:underline" title={e.action}>
                            {e.next} <ChevronRight className="size-3.5" aria-hidden />
                          </Link>
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
          )
        ) : board.view === "missing" ? (
          board.loads.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="size-6" />} title="No delivered loads are missing a ticket" description="A load appears here once its planned end time has passed (or its order is completed) and it has no live ticket. Future loads are not listed." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Load</Th>
                    <Th className="hidden md:table-cell">Truck · driver</Th>
                    <Th>Why it is listed</Th>
                    <Th align="right"><span className="sr-only">Action</span></Th>
                  </tr>
                </thead>
                <tbody>
                  {board.loads.map((l) => (
                    <Tr key={l.load_id}>
                      <Td>
                        <Link href={`/billing/orders/${l.order_id}`} className="font-semibold tabular hover:underline">{l.order_number}</Link> · load {l.load_number}
                        <div className="text-sm text-muted">{l.customer_name}</div>
                        <div className="text-sm text-muted tabular">{formatDate(l.load_date)}, {formatTime(l.start_time)} – {formatTime(l.end_time)}</div>
                      </Td>
                      <Td className="hidden md:table-cell">{l.truck ? `${l.truck}${l.trailer ? ` + ${l.trailer}` : ""} · ${l.driver}` : <span className="text-muted">Not assigned</span>}</Td>
                      <Td className="text-sm">
                        {l.voided_numbers?.length
                          ? `Ticket ${l.voided_numbers.join(", ")} was voided and not replaced.`
                          : l.order_status === "completed" && new Date(l.ends_at) > new Date()
                            ? "Order is completed; this load has no ticket."
                            : "Load ended; no ticket entered."}
                        <div className="text-muted">{l.assignment_id ? "Enter the ticket from the paper copy, or cancel the load if it did not run." : "No truck assigned. Assign it on the dispatch board and enter the ticket, or cancel the load if it did not run."}</div>
                      </Td>
                      <Td align="right">
                        {l.assignment_id && canEnterTickets ? (
                          <ButtonLink href={`/tickets/new?load=${l.load_id}`} size="sm" variant="secondary" icon={<FilePlus2 className="size-4" />}>Enter ticket</ButtonLink>
                        ) : (
                          <ButtonLink href={`/dispatch?date=${l.load_date}`} size="sm" variant="secondary" icon={<CalendarRange className="size-4" />}>Dispatch</ButtonLink>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )
        ) : board.view === "review" ? (
          board.tickets.length === 0 ? (
            <EmptyState icon={<CheckCircle2 className="size-6" />} title="No tickets waiting for review" description="Submitted and flagged tickets of scheduled and completed orders appear here until they are accepted, corrected or voided." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Ticket</Th>
                    <Th className="hidden sm:table-cell">Order / customer</Th>
                    <Th>Delivered</Th>
                    <Th>Status · reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {board.tickets.map((t) => (
                    <Tr key={t.id}>
                      <Td>
                        <Link href={`/tickets/${t.id}`} className="font-semibold whitespace-nowrap tabular hover:underline">{t.ticket_number}</Link>
                        {t.revision > 1 && <span className="ml-1 text-xs text-muted">rev {t.revision}</span>}
                        <div className="text-sm text-muted sm:hidden">{t.snapshot.order_number} · load {t.snapshot.load_number}</div>
                      </Td>
                      <Td className="hidden sm:table-cell">
                        <Link href={`/billing/orders/${t.order_id}`} className="tabular hover:underline">{t.snapshot.order_number}</Link> · load {t.snapshot.load_number}
                        <div className="text-sm text-muted">{t.snapshot.customer_name}</div>
                      </Td>
                      <Td>
                        <div className="font-semibold tabular">{trimNumber(t.quantity)} {t.unit_code}</div>
                        <div className="text-sm text-muted">{formatDateTime(t.delivered_at, board.timezone)}</div>
                      </Td>
                      <Td>
                        <TicketStatusBadge status={t.status} />
                        <div className="mt-1 max-w-64 text-xs text-muted">
                          {t.status === "needs_review" && t.review_reasons[0] ? reviewReasonLabel(t.review_reasons[0]) : "Waiting for an office reviewer to accept it."}
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )
        ) : board.view === "exceptions" ? (
          <>
            <p className="border-b border-line px-4 py-3 text-sm text-muted sm:px-5">{QUANTITY_POLICY}</p>
            {board.groups.length === 0 ? (
              <EmptyState icon={<CheckCircle2 className="size-6" />} title="No exceptions" description="Quantity differences, units that cannot be compared, lines without tickets, missing POs and zero rates appear here." />
            ) : (
              <ul className="divide-y divide-line" aria-label="Orders with exceptions">
                {board.groups.map(({ order: o, exceptions }) => (
                  <li key={o.order_id} className="px-4 py-4 sm:px-5">
                    <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <Link href={`/billing/orders/${o.order_id}`} className="font-semibold tabular hover:underline">{o.order_number}</Link>
                        <span className="text-muted"> · {o.customer_name}</span>
                        <div className="text-sm text-muted tabular">{serviceDates(o.service_start, o.service_end)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {o.acknowledgment_id ? (
                          <Badge tone="green">Acknowledged</Badge>
                        ) : (
                          <ReadinessBadge readiness={o.readiness} />
                        )}
                        {canManage && o.readiness === "blocked" && (
                          <AcknowledgeButton size="sm" orderId={o.order_id} orderNumber={o.order_number} fingerprint={o.exceptions_fingerprint} count={o.exceptions_count} />
                        )}
                      </div>
                    </div>
                    {o.acknowledgment_id && (
                      <p className="mb-2 text-sm text-muted">
                        {board.people[o.acknowledged_by ?? ""] ?? "Someone"} on {formatDateTime(o.acknowledged_at, board.timezone)}: “{o.acknowledgment_reason}”
                      </p>
                    )}
                    <ExceptionTable rows={exceptions} />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : board.view === "handed_off" ? (
          <HandedOff board={board} canManage={canManage} highlight={sp.batch}
            qb={await getQuickBooksForHandoffs(board.batches.flatMap((b) => b.orders.map((o) => o.id)), access)} />
        ) : null}
      </Card>
    </>
  );
}

function HandedOff({ board, canManage, highlight, qb }: {
  board: Extract<Awaited<ReturnType<typeof getBillingBoard>>, { view: "handed_off" }>; canManage: boolean; highlight?: string;
  qb: Awaited<ReturnType<typeof getQuickBooksForHandoffs>>;
}) {
  const unsent = (ids: Array<{ id: string; reverted_at: string | null }>) => ids.filter((o) => !o.reverted_at && !(qb.sends[o.id] ?? []).some((s) => s.status === "sent") ).map((o) => o.id);
  if (board.batches.length === 0) {
    return <EmptyState title="Nothing handed off yet" description="Batches of orders handed off for billing appear here with their file." />;
  }
  return (
    <ul className="divide-y divide-line" aria-label="Handoff batches">
      {board.batches.map(({ batch: b, orders }) => (
        <li key={b.id} className={cn("px-4 py-4 sm:px-5", highlight === b.id && "bg-amber-50/40")} aria-label={`Batch ${b.batch_number}`}>
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div>
              <span className="font-semibold tabular">Batch {b.batch_number}</span>
              {b.reference && <span className="text-muted"> · {b.reference}</span>}
              <div className="text-sm text-muted">
                {board.people[b.created_by ?? ""] ?? "Someone"} · {formatDateTime(b.created_at, board.timezone)}
                {b.export_count > 0 && ` · file downloaded ${b.export_count}× (last ${formatDateTime(b.last_exported_at, board.timezone)})`}
              </div>
              {b.notes && <div className="text-sm">{b.notes}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              {qb.canSend && unsent(orders).length > 1 && <QuickBooksSendButton handoffOrderIds={unsent(orders)} label={`Send ${unsent(orders).length} to QuickBooks`} />}
              {/* Plain link: the file is a download, not a page. */}
              <a href={`/billing/batches/${b.id}/csv`} className={buttonClasses("secondary", "sm")}>
                <Download className="size-4" />
                {b.export_count > 0 ? "Download again (CSV)" : "Download file (CSV)"}
              </a>
            </div>
          </div>
          <TableWrap>
            <Table>
              <tbody>
                {orders.map((r) => (
                  <Tr key={r.id}>
                    <Td>
                      <Link href={`/billing/orders/${r.order_id}`} className={cn("font-semibold tabular hover:underline", r.reverted_at && "line-through")}>{r.order.order_number}</Link>
                      <span className="text-sm text-muted"> · {r.order.customer_name}</span>
                      {r.reverted_at && <div className="text-sm text-muted">Undone by {board.people[r.reverted_by ?? ""] ?? "someone"}: {r.revert_reason}</div>}
                      {!r.reverted_at && r.changed && <div className="text-sm font-semibold text-amber-900">Tickets changed after the handoff — check the invoice in your accounting system.</div>}
                      {qb.shown && <QuickBooksStatus sends={qb.sends[r.id] ?? []} entityNames={qb.entityNames} />}
                    </Td>
                    <Td className="hidden sm:table-cell tabular">{serviceDates(r.order.service_start, r.order.service_end)}</Td>
                    <Td align="right" className="tabular">{formatCents(r.order.total_cents)}</Td>
                    <Td align="right">
                      {qb.canSend && unsent([r]).length > 0 && <QuickBooksSendButton handoffOrderIds={[r.id]} label={(qb.sends[r.id] ?? []).some((s) => s.status === "failed") ? "Send again" : "Send to QuickBooks"} variant="ghost" />}
                      {canManage && !r.reverted_at && <RevertHandoffButton handoffOrderId={r.id} orderId={r.order_id} orderNumber={r.order.order_number} batchNumber={b.batch_number} />}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        </li>
      ))}
    </ul>
  );
}
