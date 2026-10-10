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
import { getTicket } from "@/server/data/tickets";

export const metadata = { title: "Delivery ticket" };

const ACTION_LABELS = { submitted: "Submitted", flagged: "Flagged for review", accepted: "Accepted", voided: "Voided", corrected: "Corrected" } as const;
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

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("tickets.view");
  const { id } = await params;
  const detail = await getTicket(id);
  if (!detail) notFound();
  const { ticket: t, revisions, events, units, people } = detail;
  const { timezone } = await businessToday();
  const who = (uid: string | null) => (uid ? people[uid] ?? "Former user" : "System");
  const unitLabel = (code: string | null) => units.find((u) => u.code === code)?.label.toLowerCase() ?? code ?? "";
  const current = revisions.find((r) => r.status !== "superseded");
  const s = t.snapshot;

  return (
    <>
      <PageHeader
        title={`Ticket ${t.ticket_number}`}
        crumbs={[{ label: "Delivery Tickets", href: "/tickets" }, { label: t.ticket_number }]}
        badges={
          <>
            <TicketStatusBadge status={t.status} />
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
            <TicketActions ticketId={t.id} ticketNumber={t.ticket_number} orderId={t.order_id} status={t.status} permissions={{ edit: can(access, "tickets.edit"), review: can(access, "tickets.review") }} />
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
          <Notice tone="warning" title={t.status === "needs_review" ? "Needs office review" : "Flags raised when submitted"}>
            <ul className="space-y-0.5">
              {t.review_reasons.map((r) => (
                <li key={r} className="flex gap-1.5"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {reviewReasonLabel(r)}</li>
              ))}
            </ul>
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
                <span className="absolute top-1 -left-[5px] size-2 rounded-full bg-charcoal" aria-hidden />
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
