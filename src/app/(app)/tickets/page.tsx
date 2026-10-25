import Link from "next/link";
import { Camera, ClipboardCheck, FilePlus2 } from "lucide-react";
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { BulkAccept } from "@/components/tickets/bulk-accept";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatTime } from "@/lib/orders/schedule";
import { can } from "@/lib/permissions";
import { REVIEW_REASON_LABELS, reviewReasonLabel } from "@/lib/tickets/rules";
import { withReturn } from "@/lib/safe-redirect";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { listLoadsAwaitingTickets, listTickets, photoCounts, ticketCounts, TICKET_VIEWS, type TicketView } from "@/server/data/tickets";

export const metadata = { title: "Delivery Tickets" };

type Search = { view?: string; q?: string; reason?: string; photo?: string };

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
  const photos = await photoCounts(tickets.map((t) => t.ticket_number));
  // Narrow the current list by review reason and by whether a photo/scan is attached (shown list only).
  const reason = sp.reason && sp.reason in REVIEW_REASON_LABELS ? sp.reason : "";
  const photoFilter = sp.photo === "with" || sp.photo === "without" ? sp.photo : "";
  const shown = tickets.filter((t) => (!reason || t.review_reasons.includes(reason)) && (!photoFilter || (photoFilter === "with") === Boolean(photos.get(t.ticket_number))));
  const clean = view === "submitted" && can(access, "tickets.review")
    ? shown.filter((t) => t.status === "submitted" && t.review_reasons.length === 0).slice(0, 50)
        .map((t) => ({ id: t.id, number: t.ticket_number, summary: `${t.snapshot.order_number} load ${t.snapshot.load_number} · ${trimNumber(t.quantity)} ${t.unit_code} · ${photos.get(t.ticket_number) ? "photo attached" : "no photo"}` }))
    : [];
  const listHref = `/tickets?${new URLSearchParams({ view, ...(sp.q ? { q: sp.q } : {}), ...(reason ? { reason } : {}), ...(photoFilter ? { photo: photoFilter } : {}) })}`;
  const tabCount: Partial<Record<TicketView, number>> = { awaiting: awaiting.rows.length, review: counts.review, submitted: counts.submitted };

  return (
    <>
      <PageHeader
        title="Delivery Tickets"
        description="What was actually delivered, entered from paper or scale tickets. Separate from the dispatch plan and from billing."
      />
      <nav aria-label="Ticket views" className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
        {(Object.keys(TICKET_VIEWS) as TicketView[]).map((k) => (
          <Link
            key={k}
            href={`/tickets?view=${k}`}
            aria-current={k === view ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors duration-150",
              k === view ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
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
                          <ButtonLink href={`/tickets/new?load=${load.id}`} size="sm" variant="secondary" icon={<FilePlus2 className="size-4" />}>Enter ticket</ButtonLink>
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
            <FilterSelect name="reason" label="Review reason" value={reason} options={[{ value: "", label: "Any" }, ...Object.entries(REVIEW_REASON_LABELS).map(([value, label]) => ({ value, label: label.split(" (")[0].replace(/\.$/, "") }))]} />
            <FilterSelect name="photo" label="Photo or scan" value={photoFilter} options={[{ value: "", label: "Any" }, { value: "with", label: "Attached" }, { value: "without", label: "Missing" }]} />
          </FilterBar>
          {clean.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2 sm:px-6">
              <BulkAccept tickets={clean} />
              <span className="text-sm text-muted">Tickets with any review reason are reviewed one by one.</span>
            </div>
          )}
          {shown.length === 0 ? (
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
                  {shown.map((t) => (
                    <Tr key={t.id}>
                      <Td>
                        <Link href={t.status === "needs_review" || t.status === "submitted" ? withReturn(`/tickets/${t.id}?queue=review`, listHref) : withReturn(`/tickets/${t.id}`, listHref)} className="font-semibold whitespace-nowrap tabular hover:text-brand-fg hover:underline">{t.ticket_number}</Link>
                        {t.revision > 1 && <span className="ml-1 text-xs text-muted">rev {t.revision}</span>}
                        {photos.get(t.ticket_number) ? (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted" title="Paper ticket photo attached">
                            <Camera className="size-3.5" aria-hidden /><span className="sr-only">Photo attached</span>{photos.get(t.ticket_number)! > 1 ? photos.get(t.ticket_number) : ""}
                          </span>
                        ) : null}
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
