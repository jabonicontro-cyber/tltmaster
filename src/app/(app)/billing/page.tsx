import Link from "next/link";
import { vocabulary } from "@/lib/industry";
import { getSettings } from "@/server/data/settings";
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
import { FormError } from "@/components/ui/form";

import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import {
  EXCEPTION_KINDS, EXCEPTION_LABELS, QUANTITY_POLICY, READINESS, READINESS_LABELS, readinessExplanation, sayExplanation,
} from "@/lib/billing/rules";
import { QBO_SUPPORT_SEND_MESSAGE } from "@/lib/accounting/qbo";
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
import { invoicesByHandoff, invoicingSettings } from "@/server/data/invoices";
import { createInvoice } from "./invoices/actions";
import { getSay } from "@/server/industry";

export const metadata = { title: "Billing Readiness" };

type Search = { view?: string; q?: string; from?: string; to?: string; customer?: string; kind?: string; readiness?: string; batch?: string; error?: string };


function serviceDates(a: string | null, b: string | null) {
  if (!a) return "–";
  return b && b !== a ? `${formatDate(a)} – ${formatDate(b)}` : formatDate(a);
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const say = await getSay();
  // Ticket or BOL wording (MK1): from the company's What you haul.
  const words = vocabulary((await getSettings().catch(() => null))?.industry);
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
  const [board, invoicing] = await Promise.all([getBillingBoard(view, filters), invoicingSettings()]);
  const keep = (k: BillingView) => {
    const p = new URLSearchParams({ view: k });
    for (const f of ["q", "from", "to", "customer"] as const) if (filters[f]) p.set(f, filters[f]!);
    return `/billing?${p}`;
  };

  return (
    <>
      <PageHeader
        title="Billing Readiness"
        description={invoicing.issuer === "taviron"
          ? "Which delivered work is documented, reviewed and ready to invoice. Handed-off orders become invoices Taviron issues (Settings → Invoicing). Nothing here changes prices."
          : "Which delivered work is documented, reviewed and ready to invoice. Handed-off orders go to your accounting system by file or, once connected, by Send to QuickBooks. Nothing here changes prices or marks anything paid."}
        actions={
          <>
            <ButtonLink href="/billing/leaks" variant="secondary" size="sm">Revenue check</ButtonLink>
            {invoicing.installed && <ButtonLink href="/billing/invoices" variant="secondary" size="sm">Invoices</ButtonLink>}
            <ButtonLink href="/billing/payments" variant="secondary" size="sm">Payments by ticket</ButtonLink>
            <ButtonLink href="/billing/setup" variant="secondary" size="sm">Businesses and QuickBooks</ButtonLink>
          </>
        }
      />
      {sp.error && <div className="mb-4"><FormError message={sp.error.slice(0, 300)} /></div>}
      <BillingPipeline counts={board.counts} href={keep} current={view} />
      <nav aria-label="Billing views" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
        {(Object.keys(BILLING_VIEWS) as BillingView[]).map((k) => (
          <Link
            key={k}
            href={keep(k)}
            aria-current={k === view ? "page" : undefined}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-150",
              k === view ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
            )}
          >
            <span className="pill-text">{say(BILLING_VIEWS[k])}</span>
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
            <FilterSelect name="readiness" label="Status" value={filters.readiness} options={[{ value: "", label: "Any status" }, ...READINESS.filter((r) => r !== "handed_off").map((r) => ({ value: r, label: say(READINESS_LABELS[r]) }))]} />
          )}
          {view === "exceptions" && (
            <FilterSelect name="kind" label="Exception" value={filters.kind} options={[{ value: "", label: "All exceptions" }, ...EXCEPTION_KINDS.map((k) => ({ value: k, label: say(EXCEPTION_LABELS[k]) }))]} />
          )}
        </FilterBar>

        {board.view === "orders" || board.view === "ready" ? (
          board.orders.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 className="size-6" />}
              title={board.view === "ready" ? "No orders are ready to bill" : "No orders match"}
              description={board.view === "ready" ? say("An order is ready when it is completed, every load has an accepted ticket and every exception is acknowledged.") : "Scheduled, in-progress and completed orders appear here with what still blocks billing."}
            />
          ) : board.view === "ready" ? (
            <HandOffForm orders={board.orders} canManage={canManage} taviron={invoicing.issuer === "taviron"} />
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
                    const e = sayExplanation(readinessExplanation(o.readiness, o), say);
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
            <EmptyState icon={<CheckCircle2 className="size-6" />} title={say("No delivered loads are missing a ticket")} description={say("A load appears here once its planned end time has passed (or its order is completed) and it has no live ticket. Future loads are not listed.")} />
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
                          ? say(`Ticket ${l.voided_numbers.join(", ")} was voided and not replaced.`)
                          : l.order_status === "completed" && new Date(l.ends_at) > new Date()
                            ? say("Order is completed; this load has no ticket.")
                            : say("Load ended; no ticket entered.")}
                        <div className="text-muted">{l.assignment_id ? say("Enter the ticket from the paper copy, or cancel the load if it did not run.") : say("No truck assigned. Assign it on the dispatch board and enter the ticket, or cancel the load if it did not run.")}</div>
                      </Td>
                      <Td align="right">
                        {l.assignment_id && canEnterTickets ? (
                          <ButtonLink href={`/tickets/new?load=${l.load_id}`} size="sm" variant="secondary" icon={<FilePlus2 className="size-4" />}>{words.enter}</ButtonLink>
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
            <EmptyState icon={<CheckCircle2 className="size-6" />} title={say("No tickets waiting for review")} description={say("Submitted and flagged tickets of scheduled and completed orders appear here until they are accepted, corrected or voided.")} />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{say("Ticket")}</Th>
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
            <p className="border-b border-line px-5 py-3 text-sm text-muted sm:px-6">{say(QUANTITY_POLICY)}</p>
            {board.groups.length === 0 ? (
              <EmptyState icon={<CheckCircle2 className="size-6" />} title="No exceptions" description={say("Quantity differences, units that cannot be compared, lines without tickets, missing POs and zero rates appear here.")} />
            ) : (
              <ul className="divide-y divide-line" aria-label="Orders with exceptions">
                {board.groups.map(({ order: o, exceptions }) => (
                  <li key={o.order_id} className="px-5 py-4 sm:px-6">
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
          <HandedOff board={board} canManage={canManage} highlight={sp.batch} issuer={invoicing.issuer}
            qb={await getQuickBooksForHandoffs(board.batches.flatMap((b) => b.orders.map((o) => o.id)), access)}
            invoices={invoicing.issuer === "taviron" ? await invoicesByHandoff(board.batches.flatMap((b) => b.orders.map((o) => o.id))) : {}} />
        ) : null}
      </Card>
    </>
  );
}

async function HandedOff({ board, canManage, highlight, qb: qbAll, issuer, invoices }: {
  board: Extract<Awaited<ReturnType<typeof getBillingBoard>>, { view: "handed_off" }>; canManage: boolean; highlight?: string;
  qb: Awaited<ReturnType<typeof getQuickBooksForHandoffs>>;
  /** Who issues the company's invoices (B99): with Taviron, each order gets Create invoice instead of Send to QuickBooks. */
  issuer: "quickbooks" | "taviron";
  invoices: Awaited<ReturnType<typeof invoicesByHandoff>>;
}) {
  const say = await getSay();
  const qb = issuer === "taviron" ? { ...qbAll, canSend: false } : qbAll;
  const unsent = (ids: Array<{ id: string; reverted_at: string | null }>) => ids.filter((o) => !o.reverted_at && !(qb.sends[o.id] ?? []).some((s) => s.status === "sent") ).map((o) => o.id);
  if (board.batches.length === 0) {
    return <EmptyState title="Nothing handed off yet" description="Batches of orders handed off for billing appear here with their file." />;
  }
  // Customers with two or more handed-off orders not invoiced yet can be billed once (UX10).
  const waiting = new Map<string, number>();
  if (issuer === "taviron") for (const { orders } of board.batches) for (const r of orders) if (!r.reverted_at && !invoices[r.id]) waiting.set(r.order.customer_name ?? "", (waiting.get(r.order.customer_name ?? "") ?? 0) + 1);
  const combinable = [...waiting.values()].filter((n) => n >= 2).length;
  return (
    <>
    {issuer === "quickbooks" && qb.supportBlocked && (
      <div className="border-b border-line px-5 py-3 text-sm text-muted sm:px-6" role="note">{QBO_SUPPORT_SEND_MESSAGE} What would be sent, and what was sent, is shown below.</div>
    )}
    {canManage && combinable > 0 && (
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3 text-sm sm:px-6">
        <span className="text-muted">{combinable === 1 ? "One customer has" : `${combinable} customers have`} several orders waiting for an invoice.</span>
        <Link href="/billing/invoices/combine" className={buttonClasses("secondary", "sm")}><FilePlus2 className="size-4" />One invoice for several orders</Link>
      </div>
    )}
    <ul className="divide-y divide-line" aria-label="Handoff batches">
      {board.batches.map(({ batch: b, orders }) => (
        <li key={b.id} className={cn("px-5 py-4 sm:px-6", highlight === b.id && "bg-amber-50/40")} aria-label={`Batch ${b.batch_number}`}>
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
                      {!r.reverted_at && r.changed && <div className="text-sm font-semibold text-amber-900">{say("Tickets changed after the handoff: check the invoice in your accounting system.")}</div>}
                      {qb.shown && <QuickBooksStatus sends={qb.sends[r.id] ?? []} entityNames={qb.entityNames} />}
                    </Td>
                    <Td className="hidden sm:table-cell tabular">{serviceDates(r.order.service_start, r.order.service_end)}</Td>
                    <Td align="right" className="tabular">{formatCents(r.order.total_cents)}</Td>
                    <Td align="right">
                      {qb.canSend && unsent([r]).length > 0 && <QuickBooksSendButton handoffOrderIds={[r.id]} label={(qb.sends[r.id] ?? []).some((s) => s.status === "failed") ? "Send again" : "Send to QuickBooks"} variant="ghost" />}
                      {issuer === "taviron" && !r.reverted_at && (invoices[r.id] ? (
                        <Link href={`/billing/invoices/${invoices[r.id].id}`} className={buttonClasses("ghost", "sm")}>{invoices[r.id].number ? `Invoice ${invoices[r.id].number}` : "Draft invoice"}</Link>
                      ) : canManage ? (
                        <form action={createInvoice} className="inline">
                          <input type="hidden" name="handoff" value={r.id} />
                          <input type="hidden" name="back" value="/billing?view=handed_off" />
                          <button type="submit" className={buttonClasses("secondary", "sm")}><FilePlus2 className="size-4" />Create invoice</button>
                        </form>
                      ) : null)}
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
    </>
  );
}

/**
 * Where delivered work stands (owner's references 2026-10-27: progress bars per stage). Each count names its unit;
 * stages counted in orders show a bar out of all orders on the board (an order can sit in more than one stage, so the
 * bars are not meant to add up). Loads and tickets get no bar against orders. Each opens its view.
 */
async function BillingPipeline({ counts, href, current }: { counts: Partial<Record<BillingView, number>>; href: (k: BillingView) => string; current: BillingView }) {
  const say = await getSay();
  const total = counts.orders ?? 0;
  if (!total) return null;
  // Each stage counts in its own unit (UX15): missing tickets are loads, review is tickets, the rest are orders. Only
  // the stages counted in orders get a bar against the orders on the board; the others say what they count.
  const stages: Array<{ key: BillingView; bar: string; unit: "load" | "ticket" | "order"; ofBoard: boolean }> = [
    { key: "missing", bar: "bg-critical", unit: "load", ofBoard: false },
    { key: "exceptions", bar: "bg-amber-400", unit: "order", ofBoard: true },
    { key: "review", bar: "bg-blue-500", unit: "ticket", ofBoard: false },
    { key: "ready", bar: "bg-green-600", unit: "order", ofBoard: true },
    { key: "handed_off", bar: "bg-brand", unit: "order", ofBoard: false },
  ];
  return (
    <section aria-label="Billing pipeline" className="mb-5 rounded-panel bg-card p-5 shadow-card ring-1 ring-line/60 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-[-0.01em] text-ink">Where delivered work stands</h2>
        <p className="text-sm text-muted"><span className="font-semibold tabular text-ink">{total}</span> orders on the board</p>
      </div>
      <ul className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2 xl:grid-cols-5">
        {stages.map((st) => {
          const n = counts[st.key] ?? 0;
          return (
            <li key={st.key}>
              <Link href={href(st.key)} aria-current={st.key === current ? "page" : undefined} className="group block rounded-xl py-1 focus-visible:outline-2 focus-visible:outline-brand-fg">
                <span className="flex items-baseline justify-between gap-2 text-sm">
                  <span className={cn("font-medium group-hover:underline", st.key === current ? "text-ink" : "text-muted")}>{say(BILLING_VIEWS[st.key])}</span>
                  <span className="whitespace-nowrap tabular text-ink"><span className="font-semibold">{n}</span> <span className="text-xs text-muted">{st.unit}{n === 1 ? "" : "s"}</span></span>
                </span>
                {st.ofBoard ? (
                  <span className="mt-2 block h-2.5 overflow-hidden rounded-full bg-ink/[0.06]" aria-hidden>
                    <span className={cn("block h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none", st.bar)} style={{ width: `${n ? Math.max(3, Math.round((n / total) * 100)) : 0}%` }} />
                  </span>
                ) : (
                  <span className="mt-1.5 block text-xs text-muted">{st.key === "handed_off" ? "already handed to billing" : st.unit === "load" ? say("delivered loads without a ticket") : "waiting for review"}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
