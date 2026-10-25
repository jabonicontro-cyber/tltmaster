import { CopyReference } from "@/components/ui/copy-reference";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { TicketActions } from "@/components/tickets/ticket-actions";
import { TicketStatusBadge } from "@/components/tickets/ticket-badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatDate, formatDateTime } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { can } from "@/lib/permissions";
import { reviewReasonLabel, TICKET_STATUS_LABELS } from "@/lib/tickets/rules";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { getTicket, getTicketContext, reviewQueuePosition } from "@/server/data/tickets";
import { QueueKeys } from "@/components/tickets/queue-keys";
import { TicketScanUpload } from "@/components/tickets/ticket-scan-upload";
import { lineProgress } from "@/lib/tickets/context";
import { REVIEW_REASON_HELP } from "@/lib/tickets/rules";
import { formatCents } from "@/lib/money";
import { cn } from "@/lib/cn";
import { ReturnLink } from "@/components/ui/return-link";
import { returnTarget, withReturn } from "@/lib/safe-redirect";

export const metadata = { title: "Delivery ticket" };

const ACTION_LABELS = { submitted: "Submitted", flagged: "Flagged for review", accepted: "Accepted", voided: "Voided", corrected: "Corrected", photo_added: "Scan or photo added" } as const;
const FIELD_LABELS: Record<string, string> = {
  quantity: "Quantity",
  unit_code: "Unit",
  delivered_at: "Delivered at",
  external_reference: "Paper ticket #",
  order_line_id: "Order line",
  truck_id: "Truck",
  trailer_id: "Trailer",
  driver_id: "Driver",
  notes: "Notes",
};

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ queue?: string; back?: string }> }) {
  const access = await requirePagePermission("tickets.view");
  const { id } = await params;
  const { queue: queueParam, back } = await searchParams;
  const detail = await getTicket(id);
  if (!detail) notFound();
  // Opened from the review queue: show its position and where to go next.
  const inQueue = queueParam === "review";
  const [queue, context] = await Promise.all([inQueue ? reviewQueuePosition(id) : Promise.resolve(null), getTicketContext(detail.ticket)]);
  const returnTo = returnTarget(back)?.href ?? (inQueue ? "/tickets?view=review" : null);
  const queueHref = (ticketId: string) => (returnTo ? withReturn(`/tickets/${ticketId}?queue=review`, returnTo) : `/tickets/${ticketId}?queue=review`);
  const { ticket: t, revisions, events, units, people, photos } = detail;
  const { timezone } = await businessToday();
  const who = (uid: string | null) => (uid ? people[uid] ?? "Former user" : "System");
  const unitLabel = (code: string | null) => units.find((u) => u.code === code)?.label.toLowerCase() ?? code ?? "";
  const current = revisions.find((r) => r.status !== "superseded");
  const s = t.snapshot;
  const live = t.status !== "voided" && t.status !== "superseded";
  const progress = context.line ? lineProgress(context.line, context.lineTickets, t.id) : null;
  const loadTickets = context.lineTickets.filter((x) => x.load_id === t.load_id && x.id !== t.id);
  const a = context.assignment;
  const differs = (field: "truck_id" | "trailer_id" | "driver_id") => Boolean(a && (a[field] ?? null) !== (t[field] ?? null));

  return (
    <>
      <ReturnLink back={returnTo ?? undefined} />
      {queue && <QueueKeys nextHref={queue.nextId && queue.nextId !== t.id ? queueHref(queue.nextId) : null} prevHref={queue.prevId ? queueHref(queue.prevId) : null} />}
      {queue && (
        <nav aria-label="Review queue" className="mb-3 flex flex-wrap items-center gap-3 rounded-control border border-line bg-card px-3 py-2 text-sm">
          <span className="font-semibold">
            {queue.position ? `Review queue: ${queue.position} of ${queue.total}` : queue.total ? `Not in the review queue any more · ${queue.total} waiting` : "The review queue is empty"}
          </span>
          {queue.prevId && <Link href={queueHref(queue.prevId)} className="underline">Previous</Link>}
          {queue.nextId && queue.nextId !== t.id && <Link href={queueHref(queue.nextId)} className="underline">Next</Link>}
          <span className="ml-auto hidden text-xs text-muted sm:inline">Keys: J next · K previous · A accept (asks to confirm)</span>
        </nav>
      )}
      <PageHeader
        title={`Ticket ${t.ticket_number}`}
        crumbs={[{ label: "Delivery Tickets", href: "/tickets" }, { label: t.ticket_number }]}
        badges={
          <>
            <TicketStatusBadge status={t.status} />
            <CopyReference value={t.ticket_number} label="ticket number" />
            {t.revision > 1 && <span className="text-sm font-semibold text-muted">Revision {t.revision}</span>}
          </>
        }
        description={
          <>
            <Link href={`/orders/${t.order_id}`} className="font-semibold text-ink hover:underline">{s.order_number}</Link> load {s.load_number} · {s.customer_name}
          </>
        }
        actions={
          t.status !== "superseded" ? (
            <TicketActions
              ticketId={t.id}
              ticketNumber={t.ticket_number}
              orderId={t.order_id}
              status={t.status}
              permissions={{ edit: can(access, "tickets.edit"), review: can(access, "tickets.review") }}
              queue={queue ? { nextHref: queue.nextId && queue.nextId !== t.id ? queueHref(queue.nextId) : null, doneHref: returnTo ?? "/tickets?view=review" } : null}
            />
          ) : undefined
        }
      />

      <div className="mb-5 space-y-3">
        {t.status === "superseded" && current && (
          <Notice tone="warning" title={`This is revision ${t.revision}, replaced by a correction`}>
            See the <Link href={`/tickets/${current.id}`} className="font-semibold underline">current revision {current.revision}</Link>.
          </Notice>
        )}
        {t.status === "voided" && (
          <Notice tone="warning" title="Voided">
            {t.void_reason} — {who(t.voided_by)}, {formatDateTime(t.voided_at, timezone)}. The ticket no longer counts for the load.
          </Notice>
        )}
        {t.review_reasons.length > 0 && t.status !== "voided" && (
          <Notice tone="warning" title={t.status === "accepted" ? "Flags raised when submitted — resolved: accepted by a reviewer" : t.status === "superseded" ? "Flags on this revision" : "Needs office review before it counts as verified"}>
            <ul className="space-y-2" aria-label="Review reasons">
              {t.review_reasons.map((r) => {
                const help = REVIEW_REASON_HELP[r];
                return (
                  <li key={r}>
                    <p className="flex gap-1.5 font-semibold"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {reviewReasonLabel(r)}</p>
                    {help && t.status !== "accepted" && (
                      <dl className="mt-0.5 ml-6 grid gap-0.5 text-sm">
                        <div><dt className="inline font-semibold">Why it matters: </dt><dd className="inline">{help.why}</dd></div>
                        <div><dt className="inline font-semibold">Next: </dt><dd className="inline">{help.next}</dd></div>
                        <div><dt className="inline font-semibold">Handled by: </dt><dd className="inline">{help.who}</dd></div>
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          </Notice>
        )}
        {t.status === "submitted" && t.review_reasons.length === 0 && (
          <Notice title="Received, not verified yet">
            Nothing was flagged. Compare it with the paper ticket or photo, then accept it. Until then it does not count as verified for billing.
          </Notice>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title="Delivery" description="As entered from the paper or scale ticket." />
            <CardBody>
              <DescriptionList
                items={[
                  { label: "Delivered", value: <span className="text-lg font-black tabular">{trimNumber(t.quantity)} {unitLabel(t.unit_code)}</span> },
                  { label: "Delivered at", value: formatDateTime(t.delivered_at, timezone) },
                  { label: "Material / line", value: s.line_description + (s.line_unit_code && s.line_unit_code !== t.unit_code ? ` (order line in ${unitLabel(s.line_unit_code)})` : "") },
                  { label: "Paper / scale ticket #", value: t.external_reference },
                  {
                    label: "Planned for this load",
                    value: `${formatDate(s.load_date)}${s.planned_quantity !== null ? ` · ${trimNumber(s.planned_quantity)} ${unitLabel(s.planned_unit_code)} (plan only)` : ""}`,
                  },
                  { label: "Truck · driver", value: `${s.truck_unit}${s.trailer_unit ? ` + ${s.trailer_unit}` : ""} · ${s.driver_name}` },
                  { label: "Entered", value: `${formatDateTime(t.created_at, timezone)} by ${who(t.created_by)}` },
                  ...(t.reviewed_at ? [{ label: "Reviewed", value: `${formatDateTime(t.reviewed_at, timezone)} by ${who(t.reviewed_by)}${t.review_note ? ` — ${t.review_note}` : ""}` }] : []),
                  ...(t.correction_reason ? [{ label: "Correction reason", value: t.correction_reason, wide: true }] : []),
                  { label: "Notes", value: t.notes, wide: true },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Delivery context" description="From the order, the dispatch assignment and the other tickets on this order line. Same unit only — nothing is converted." />
            <CardBody className="space-y-4">
              {progress ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4" aria-label="Order line progress">
                  <div><dt className="text-muted">Ordered</dt><dd className="font-semibold tabular">{progress.ordered} {unitLabel(progress.unit)}</dd></div>
                  <div><dt className="text-muted">Verified on other tickets</dt><dd className="font-semibold tabular">{progress.verifiedOthers}</dd></div>
                  <div><dt className="text-muted">This ticket</dt><dd className="font-semibold tabular">{progress.thisTicket ?? `other unit (${unitLabel(t.unit_code)})`}</dd></div>
                  <div>
                    <dt className="text-muted">Remaining after this</dt>
                    <dd className={cn("font-semibold tabular", progress.over && "text-brand-fg")}>{progress.over ? `${progress.remainingAfterThis.replace("-", "")} over the order` : progress.remainingAfterThis}</dd>
                  </div>
                  {progress.pendingOthers !== "0" && <div className="col-span-2 sm:col-span-4 text-muted">Also waiting for review on this line: {progress.pendingOthers} {unitLabel(progress.unit)}.</div>}
                  {progress.otherUnitTickets > 0 && <div className="col-span-2 sm:col-span-4 text-muted">{progress.otherUnitTickets} ticket(s) on this line are in another unit and are not added.</div>}
                </dl>
              ) : (
                <p className="text-sm text-muted">The order line could not be loaded.</p>
              )}
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                {context.line && <div><dt className="inline text-muted">Order price (as accepted): </dt><dd className="inline tabular">{formatCents(context.line.unit_rate_cents)} / {unitLabel(context.line.unit_code)} — not changed by tickets</dd></div>}
                {context.order && <div><dt className="inline text-muted">Customer PO: </dt><dd className="inline">{context.order.customer_po || "none on the order"}</dd></div>}
                {context.order && <div><dt className="inline text-muted">Site: </dt><dd className="inline">{[context.order.site_label, context.order.site_city].filter(Boolean).join(", ") || "—"}</dd></div>}
                <div>
                  <dt className="inline text-muted">Dispatch assignment: </dt>
                  <dd className="inline">
                    {!a ? "not found" : differs("truck_id") || differs("trailer_id") || differs("driver_id") ? <strong className="text-brand-fg">differs from this ticket ({[differs("truck_id") && "truck", differs("trailer_id") && "trailer", differs("driver_id") && "driver"].filter(Boolean).join(", ")})</strong> : "matches this ticket"}
                    {a?.status === "canceled" ? " (assignment since removed)" : ""}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="inline text-muted">Other tickets on this load: </dt>
                  <dd className="inline">
                    {loadTickets.length === 0 ? "none" : loadTickets.map((x, i) => (
                      <span key={x.id}>{i > 0 ? ", " : ""}<Link href={`/tickets/${x.id}`} className="font-semibold underline">{x.ticket_number}</Link> ({TICKET_STATUS_LABELS[x.status].toLowerCase()}, {trimNumber(x.quantity)} {unitLabel(x.unit_code)})</span>
                    ))}
                  </dd>
                </div>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title={`Paper ticket photos (${photos.length})`}
              description={photos.length ? "From the driver or the office. Kept with the ticket number through corrections and voids. Each opens a link valid for one minute." : "No photo or scan is attached yet."}
            />
            {live && can(access, "tickets.edit") && (
              <div className="border-b border-line px-4 py-3 sm:px-5"><TicketScanUpload ticketId={t.id} /></div>
            )}
            {photos.length > 0 && (
              <CardBody>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Paper ticket photos">
                  {photos.map((p, i) => {
                    const rev = revisions.find((r) => r.id === p.ticket_id)?.revision;
                    return (
                      <li key={p.id}>
                        <a href={`/tickets/photos/${p.id}`} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl border border-line hover:border-strong">
                          {/* eslint-disable-next-line @next/next/no-img-element -- served through an authorized, short-lived link */}
                          <img src={`/tickets/photos/${p.id}`} alt={`Paper ticket photo ${i + 1}`} loading="lazy" className="aspect-[3/4] w-full bg-surface object-cover" />
                        </a>
                        <p className="mt-1 text-xs text-muted">
                          {formatDateTime(p.attached_at, timezone)} · {Math.ceil(p.size_bytes / 1024)} KB{rev && revisions.length > 1 ? ` · revision ${rev}` : ""}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              </CardBody>
            )}
          </Card>

          {revisions.length > 1 && (
            <Card>
              <CardHeader title="Revisions" description="Every revision is kept. Only the newest is current." />
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>Rev</Th>
                      <Th>Quantity</Th>
                      <Th className="hidden sm:table-cell">Delivered at</Th>
                      <Th className="hidden md:table-cell">Paper #</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {revisions.map((r) => (
                      <Tr key={r.id}>
                        <Td>
                          <Link href={`/tickets/${r.id}`} className="font-semibold hover:underline">{r.revision}</Link>
                          {r.id === t.id && <span className="ml-1 text-xs text-muted">(viewing)</span>}
                        </Td>
                        <Td className="tabular">{trimNumber(r.quantity)} {r.unit_code}</Td>
                        <Td className="hidden sm:table-cell">{formatDateTime(r.delivered_at, timezone)}</Td>
                        <Td className="hidden md:table-cell">{r.external_reference || "—"}</Td>
                        <Td><TicketStatusBadge status={r.status} /></Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            </Card>
          )}
        </div>

        <Card className="self-start">
          <CardHeader title="History" description="All actions on this ticket number, newest first." />
          <ol className="px-4 py-3 sm:px-5" aria-label="Ticket history">
            {events.map((e) => (
              <li key={e.id} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
                <span className="absolute top-1 -left-[5px] size-2 rounded-full bg-strong" aria-hidden />
                <p className="text-sm font-semibold">
                  {ACTION_LABELS[e.action]}
                  {e.action === "corrected" && e.details.revision ? ` → revision ${e.details.revision}` : ""}
                  <span className="font-normal text-muted"> · {TICKET_STATUS_LABELS[e.to_status]}</span>
                </p>
                {e.note && <p className="text-sm">{e.note}</p>}
                {e.details.changes &&
                  Object.entries(e.details.changes).map(([k, c]) => (
                    <p key={k} className="text-sm">
                      <span className="text-muted">{FIELD_LABELS[k] ?? k}:</span>{" "}
                      {k.endsWith("_id") ? "changed" : (
                        <>
                          <span className="line-through decoration-muted">{k === "delivered_at" ? formatDateTime(String(c.from), timezone) : String(c.from ?? "—")}</span> →{" "}
                          {k === "delivered_at" ? formatDateTime(String(c.to), timezone) : String(c.to ?? "—")}
                        </>
                      )}
                    </p>
                  ))}
                <p className="text-xs text-muted">{formatDateTime(e.occurred_at, timezone)} · {who(e.actor_id)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
