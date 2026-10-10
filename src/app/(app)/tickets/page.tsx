import Link from "next/link";
import { ClipboardCheck, FilePlus2 } from "lucide-react";
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatTime } from "@/lib/orders/schedule";
import { can } from "@/lib/permissions";
import { reviewReasonLabel } from "@/lib/tickets/rules";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { listLoadsAwaitingTickets, listTickets, ticketCounts, TICKET_VIEWS, type TicketView } from "@/server/data/tickets";

export const metadata = { title: "Delivery Tickets" };

type Search = { view?: string; q?: string };

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("tickets.view");
  const sp = await searchParams;
  const view: TicketView = sp.view && sp.view in TICKET_VIEWS ? (sp.view as TicketView) : "awaiting";
  const canEdit = can(access, "tickets.edit");
  const [counts, awaiting, tickets, { timezone }] = await Promise.all([
    ticketCounts(),
    listLoadsAwaitingTickets(),
    view === "awaiting" ? Promise.resolve([]) : listTickets(view, sp.q),
    businessToday(),
  ]);
  const tabCount: Partial<Record<TicketView, number>> = { awaiting: awaiting.rows.length, review: counts.review, submitted: counts.submitted };

  return (
    <>
      <PageHeader
        title="Delivery Tickets"
        description="What was actually delivered, entered from paper or scale tickets. Separate from the dispatch plan and from billing."
      />
      <nav aria-label="Ticket views" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {(Object.keys(TICKET_VIEWS) as TicketView[]).map((k) => (
          <Link
            key={k}
            href={`/tickets?view=${k}`}
            aria-current={k === view ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[15px] font-semibold whitespace-nowrap",
              k === view ? "border-brand text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {TICKET_VIEWS[k]}
            {tabCount[k] ? <Badge tone={k === "review" ? "amber" : "gray"}>{tabCount[k]}</Badge> : null}
          </Link>
        ))}
      </nav>

      {view === "awaiting" ? (
        <Card>
          {awaiting.rows.length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck className="size-6" />}
              title="No loads waiting for a ticket"
              description="Assigned loads appear here from their delivery day until a ticket is entered."
            />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Load</Th>
                    <Th>Customer / site</Th>
                    <Th className="hidden md:table-cell">Truck · driver</Th>
                    <Th className="hidden sm:table-cell">Planned</Th>
                    <Th align="right"><span className="sr-only">Action</span></Th>
                  </tr>
                </thead>
                <tbody>
                  {awaiting.rows.map(({ load, order, truck, trailer, driver }) => (
                    <Tr key={load.id}>
                      <Td>
                        <Link href={`/orders/${order.id}`} className="font-semibold tabular hover:underline">{order.order_number}</Link> · load {load.load_number}
                        <div className="text-sm text-muted tabular">{formatDate(load.load_date)}, {formatTime(load.start_time)} – {formatTime(load.end_time)}</div>
                      </Td>
                      <Td>
                        {order.customer_name}
                        <div className="text-sm text-muted">{[order.site_label || order.site_line1, order.site_city].filter(Boolean).join(", ")}</div>
                      </Td>
                      <Td className="hidden md:table-cell">{truck}{trailer ? ` + ${trailer}` : ""} · {driver}</Td>
                      <Td className="hidden sm:table-cell tabular">{load.planned_quantity !== null ? `${trimNumber(load.planned_quantity)} ${load.unit_code}` : <span className="text-muted">—</span>}</Td>
                      <Td align="right">
                        {canEdit && (
                          <ButtonLink href={`/tickets/new?load=${load.id}`} size="sm" icon={<FilePlus2 className="size-4" />}>Enter ticket</ButtonLink>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      ) : (
        <Card>
          <FilterBar action="/tickets" query={sp.q} placeholder="Search ticket #, paper ticket #, order #, customer, truck, driver…" clearHref={`/tickets?view=${view}`}>
            <input type="hidden" name="view" value={view} />
          </FilterBar>
          {tickets.length === 0 ? (
            <EmptyState title={sp.q ? "No tickets match this search" : `No tickets — ${TICKET_VIEWS[view].toLowerCase()}`} description={view === "review" ? "Tickets flagged for office review appear here." : undefined} />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Ticket</Th>
                    <Th className="hidden sm:table-cell">Order / customer</Th>
                    <Th>Delivered</Th>
                    <Th className="hidden md:table-cell">Truck · driver</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((t) => (
                    <Tr key={t.id}>
                      <Td>
                        <Link href={`/tickets/${t.id}`} className="font-semibold whitespace-nowrap tabular hover:text-brand hover:underline">{t.ticket_number}</Link>
                        {t.revision > 1 && <span className="ml-1 text-xs text-muted">rev {t.revision}</span>}
                        {t.external_reference && <div className="text-sm text-muted">Paper # {t.external_reference}</div>}
                        <div className="text-sm text-muted sm:hidden">{t.snapshot.order_number} · load {t.snapshot.load_number}</div>
                      </Td>
                      <Td className="hidden sm:table-cell">
                        <span className="tabular">{t.snapshot.order_number}</span> · load {t.snapshot.load_number}
                        <div className="text-sm text-muted">{t.snapshot.customer_name}</div>
                      </Td>
                      <Td>
                        <div className="font-semibold tabular">{trimNumber(t.quantity)} {t.unit_code}</div>
                        <div className="text-sm text-muted">{formatDateTime(t.delivered_at, timezone)}</div>
                      </Td>
                      <Td className="hidden md:table-cell">{t.snapshot.truck_unit}{t.snapshot.trailer_unit ? ` + ${t.snapshot.trailer_unit}` : ""} · {t.snapshot.driver_name}</Td>
                      <Td>
                        <TicketStatusBadge status={t.status} />
                        {t.status === "needs_review" && t.review_reasons[0] && <div className="mt-1 max-w-56 text-xs text-muted">{reviewReasonLabel(t.review_reasons[0])}</div>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      )}
    </>
  );
}
