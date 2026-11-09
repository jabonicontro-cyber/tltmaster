import Link from "next/link";
import { vocabulary } from "@/lib/industry";
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
import { businessToday, getSettings } from "@/server/data/settings";
import { CHECK_FILTERS, listLoadsAwaitingTickets, listTickets, photoCounts, resourceNames, ticketCounts, ticketViewFromParams, TICKET_VIEWS, type CheckFilter, type TicketView } from "@/server/data/tickets";
import { getSay } from "@/server/industry";

export async function generateMetadata() {
  const s = await getSettings().catch(() => null);
  return { title: vocabulary(s?.industry).documents };
}

type Search = { view?: string; show?: string; q?: string; reason?: string; photo?: string };

export default async function TicketsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const say = await getSay();
  const access = await requirePagePermission("tickets.view");
  const sp = await searchParams;
  const { view, show } = ticketViewFromParams(sp.view, sp.show);
  const canEdit = can(access, "tickets.edit");
  const [counts, awaiting, tickets, { timezone }, names] = await Promise.all([
    ticketCounts(),
    listLoadsAwaitingTickets(),
    view === "awaiting" ? Promise.resolve([]) : listTickets(view, sp.q, show),
    businessToday(),
    // Driver names as the ticket form and the driver list show them (the ticket's saved name only as a fallback).
    resourceNames(),
  ]);
  const photos = await photoCounts(tickets.map((t) => t.ticket_number));
  // The section's name follows what the company hauls (MK1): delivery tickets, bills of lading, or both.
  const words = vocabulary((await getSettings().catch(() => null))?.industry);
  const viewLabel = (k: TicketView) => (k === "awaiting" ? `Loads awaiting a ${words.one}` : k === "all" ? `All ${words.many}` : TICKET_VIEWS[k]);
  // Narrow the current list by review reason and by whether a photo/scan is attached (shown list only).
  const reason = sp.reason && sp.reason in REVIEW_REASON_LABELS ? sp.reason : "";
  const photoFilter = sp.photo === "with" || sp.photo === "without" ? sp.photo : "";
  const shown = tickets.filter((t) => (!reason || t.review_reasons.includes(reason)) && (!photoFilter || (photoFilter === "with") === Boolean(photos.get(t.ticket_number))));
  const clean = view === "check" && show !== "flagged" && can(access, "tickets.review")
    ? shown.filter((t) => t.status === "submitted" && t.review_reasons.length === 0).slice(0, 50)
        .map((t) => ({ id: t.id, number: t.ticket_number, summary: `${t.snapshot.order_number} load ${t.snapshot.load_number} · ${trimNumber(t.quantity)} ${t.unit_code} · ${photos.get(t.ticket_number) ? "photo attached" : "no photo"}` }))
    : [];
  const listHref = `/tickets?${new URLSearchParams({ view, ...(view === "check" && show !== "all" ? { show } : {}), ...(sp.q ? { q: sp.q } : {}), ...(reason ? { reason } : {}), ...(photoFilter ? { photo: photoFilter } : {}) })}`;
  const tabCount: Partial<Record<TicketView, number>> = { awaiting: awaiting.rows.length, check: counts.review + counts.submitted };
  const checkCount: Record<CheckFilter, number> = { all: counts.review + counts.submitted, flagged: counts.review, new: counts.submitted };
  // A ticket opened from "To check" keeps its place in the same list (position and Next follow this filter).
  const queueName = show === "all" ? "review" : show;

  return (
    <>
      <PageHeader
        title={words.documents}
        description={words.description}
      />
      <nav aria-label={say("Ticket views")} className="mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full bg-ink/[0.05] p-1">
        {(Object.keys(TICKET_VIEWS) as TicketView[]).map((k) => (
          <Link
            key={k}
            href={`/tickets?view=${k}`}
            aria-current={k === view ? "page" : undefined}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-150",
              k === view ? "bg-card text-ink shadow-xs" : "text-muted hover:text-ink",
            )}
          >
            <span className="pill-text">{viewLabel(k)}</span>
            {tabCount[k] ? <Badge tone={k === "check" ? "amber" : "gray"}>{tabCount[k]}</Badge> : null}
          </Link>
        ))}
      </nav>

      {view === "awaiting" ? (
        <Card>
          {awaiting.rows.length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck className="size-6" />}
              title={`No loads waiting for a ${words.one}`}
              description={`Loads appear here from their delivery day until a ${words.one} is entered.`}
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
                  {awaiting.rows.map(({ load, order, assignment, truck, trailer, driver }) => (
                    <Tr key={load.id}>
                      <Td>
                        <Link href={`/orders/${order.id}`} className="font-semibold tabular hover:underline">{order.order_number}</Link> · load {load.load_number}
                        <div className="text-sm text-muted tabular">{formatDate(load.load_date)}, {formatTime(load.start_time)} – {formatTime(load.end_time)}</div>
                      </Td>
                      <Td>
                        {order.customer_name}
                        <div className="text-sm text-muted">{[order.site_label || order.site_line1, order.site_city].filter(Boolean).join(", ")}</div>
                      </Td>
                      <Td className="hidden md:table-cell">{assignment ? <>{truck}{trailer ? ` + ${trailer}` : ""} · {driver}</> : <span className="text-muted">Not assigned</span>}</Td>
                      <Td className="hidden sm:table-cell tabular">{load.planned_quantity !== null ? `${trimNumber(load.planned_quantity)} ${(load.unit_code ?? "").replace(/_/g, " ")}` : <span className="text-muted">–</span>}</Td>
                      <Td align="right">
                        {!assignment ? (
                          <Link href={`/dispatch?date=${load.load_date}`} className="text-sm font-medium text-brand-fg hover:underline">Assign in Dispatch</Link>
                        ) : canEdit && (
                          <ButtonLink href={`/tickets/new?load=${load.id}`} size="sm" variant="secondary" icon={<FilePlus2 className="size-4" />}>{words.enter}</ButtonLink>
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
          {view === "check" && (
            <div className="border-b border-line px-5 py-3 sm:px-6">
              <p className="text-sm text-muted">{say("The office's queue: every ticket here waits for someone to compare it with the paper ticket and accept, correct or void it. Oldest first.")}</p>
              <nav aria-label={say("To check filters")} className="mt-2 flex flex-wrap gap-2">
                {(Object.keys(CHECK_FILTERS) as CheckFilter[]).map((f) => (
                  <Link key={f} href={f === "all" ? "/tickets?view=check" : `/tickets?view=check&show=${f}`} aria-current={show === f ? "page" : undefined}
                    className={cn("inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium", show === f ? "border-strong bg-strong text-white" : "border-line bg-card text-ink hover:border-strong/30")}>
                    <span className="pill-text">{CHECK_FILTERS[f].label}</span>
                    <Badge tone={show === f ? "dark" : "gray"}>{checkCount[f]}</Badge>
                  </Link>
                ))}
              </nav>
            </div>
          )}
          <FilterBar action="/tickets" query={sp.q} placeholder={`Search ${words.one} #, paper #, order #, customer, truck, driver…`} clearHref={view === "check" && show !== "all" ? `/tickets?view=check&show=${show}` : `/tickets?view=${view}`}>
            <input type="hidden" name="view" value={view} />
            {view === "check" && show !== "all" && <input type="hidden" name="show" value={show} />}
            <FilterSelect name="reason" label="Review reason" value={reason} options={[{ value: "", label: "Any" }, ...Object.entries(REVIEW_REASON_LABELS).map(([value, label]) => ({ value, label: say(label.split(" (")[0].replace(/\.$/, "")) }))]} />
            <FilterSelect name="photo" label="Photo or scan" value={photoFilter} options={[{ value: "", label: "Any" }, { value: "with", label: "Attached" }, { value: "without", label: "Missing" }]} />
          </FilterBar>
          {clean.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-2 sm:px-6">
              <BulkAccept tickets={clean} />
              <span className="text-sm text-muted">{say("Tickets with any review reason are reviewed one by one.")}</span>
            </div>
          )}
          {shown.length === 0 ? (
            <EmptyState title={sp.q ? `No ${words.many} match this search` : `No ${words.many} · ${viewLabel(view).toLowerCase()}`} description={view === "check" ? say("Tickets entered by drivers or the office appear here until someone accepts, corrects or voids them.") : undefined} />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>{words.document}</Th>
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
                        <Link href={t.status === "needs_review" || t.status === "submitted" ? withReturn(`/tickets/${t.id}?queue=${view === "check" ? queueName : "review"}`, listHref) : withReturn(`/tickets/${t.id}`, listHref)} className="font-semibold whitespace-nowrap tabular hover:text-brand-fg hover:underline">{t.ticket_number}</Link>
                        {t.revision > 1 && <span className="ml-1 text-xs text-muted">rev {t.revision}</span>}
                        {photos.get(t.ticket_number) ? (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted" title={say("Paper ticket photo attached")}>
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
                      <Td className="hidden md:table-cell">{t.snapshot.truck_unit}{t.snapshot.trailer_unit ? ` + ${t.snapshot.trailer_unit}` : ""} · {names.drivers.get(t.driver_id) ?? t.snapshot.driver_name}</Td>
                      <Td>
                        <TicketStatusBadge status={t.status} />
                        {t.status === "needs_review" && t.review_reasons[0] && <div className="mt-1 max-w-56 text-xs text-muted">{say(reviewReasonLabel(t.review_reasons[0]))}{t.review_reasons.length > 1 ? ` (+${t.review_reasons.length - 1} more)` : ""}</div>}
                        {t.status === "needs_review" && t.review_note && <div className="mt-1 max-w-56 text-xs text-muted">Note: {t.review_note}</div>}
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
