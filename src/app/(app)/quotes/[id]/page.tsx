import { CopyReference } from "@/components/ui/copy-reference";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { QuoteActions } from "@/components/quotes/quote-actions";
import { QuoteLinesTable } from "@/components/quotes/quote-lines-table";
import { Badge, QuoteStatusBadge, SampleBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { FlashToast } from "@/components/ui/flash-toast";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { formatBp, formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/dates";
import { can } from "@/lib/permissions";
import { isPastExpiration, QUOTE_STATUS_LABELS } from "@/lib/quotes/status";
import { requirePagePermission } from "@/server/auth";
import { getQuoteDetail } from "@/server/data/quotes";
import { getOrderForQuote } from "@/server/data/orders";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Quote" };

const DELIVERY_LABEL = {
  sent: { label: "Sent", tone: "green" },
  failed: { label: "Failed — not sent", tone: "red" },
  preview: { label: "Preview only — not sent", tone: "gray" },
  test_sent: { label: "Test email — not to customer", tone: "amber" },
} as const;

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const access = await requirePagePermission("quotes.view");
  const { id } = await params;
  const detail = await getQuoteDetail(id);
  if (!detail) notFound();
  const { quote, customer, versions, current, lines, events, deliveries, names } = detail;
  const [{ today, timezone }, order] = await Promise.all([businessToday(), can(access, "orders.view") ? getOrderForQuote(quote.id) : Promise.resolve(null)]);
  const pastExpiration = isPastExpiration(quote.status, current.valid_until, today);
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "System");
  const site = [current.site_label, current.site_line1, current.site_line2, [current.site_city, current.site_state, current.site_postal_code].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      <Suspense>
        <FlashToast messages={{ saved: { text: "Quote saved." } }} />
      </Suspense>
      <PageHeader
        title={quote.quote_number}
        crumbs={[{ label: "Quotes", href: "/quotes" }, { label: quote.quote_number }]}
        badges={
          <>
            <QuoteStatusBadge status={quote.status} />
            <CopyReference value={quote.quote_number} label="quote number" />
            <Badge tone="gray">Revision {current.version_no}</Badge>
            {current.locked_at && <Badge tone="dark">Issued</Badge>}
            <SampleBadge show={quote.is_sample} />
          </>
        }
        description={
          <>
            <Link href={`/customers/${customer.id}`} className="font-semibold text-ink hover:underline">{customer.name}</Link>
            {current.project_name ? ` · ${current.project_name}` : ""} · Total <strong className="text-ink">{formatCents(current.total_cents)}</strong>
          </>
        }
      />

      <div className="mb-5">
        <QuoteActions
          quoteId={quote.id}
          quoteNumber={quote.quote_number}
          status={quote.status}
          versionId={current.id}
          versionLocked={Boolean(current.locked_at)}
          editSeq={current.edit_seq}
          permissions={{ edit: can(access, "quotes.edit"), send: can(access, "quotes.send"), status: can(access, "quotes.status"), convert: can(access, "orders.edit") }}
          order={order}
        />
      </div>

      <div className="mb-5 space-y-3">
        {pastExpiration && (
          <Notice tone="warning" title="Past expiration">
            This quote expired on {formatDate(current.valid_until)} with no response recorded. Follow up, revise it, or mark it expired.
          </Notice>
        )}
        {quote.status === "draft" && current.version_no > 1 && (
          <Notice title={`Revision ${current.version_no} in progress`}>
            Reason: {current.revision_reason}. The customer still has revision {current.version_no - 1} until this one is sent.
          </Notice>
        )}
        {quote.status === "accepted" && (
          <Notice title={order ? `Accepted — converted to order ${order.order_number}` : "Accepted"}>
            Accepted {quote.accepted_at ? formatDateTime(quote.accepted_at, timezone) : ""}
            {quote.status_note ? ` — ${quote.status_note}` : ""}.{" "}
            {order ? (
              <>
                The order was created from revision{" "}
                {versions.find((v) => v.id === quote.accepted_version_id)?.version_no ?? current.version_no}.{" "}
                <Link href={`/orders/${order.id}`} className="font-semibold underline">Open order {order.order_number}</Link>
              </>
            ) : can(access, "orders.edit") ? (
              "Use “Convert to order” to create the order."
            ) : (
              "An office user or owner can convert it to an order."
            )}
          </Notice>
        )}
        {(quote.status === "declined" || quote.status === "canceled" || quote.status === "expired") && quote.status_note && (
          <Notice tone="warning" title={QUOTE_STATUS_LABELS[quote.status]}>{quote.status_note}</Notice>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title="Details" description={current.locked_at ? `Issued ${formatDateTime(current.locked_at, timezone)} — this revision can no longer change.` : "Draft — can still be edited."} />
            <CardBody>
              <DescriptionList
                items={[
                  { label: "Customer", value: <Link href={`/customers/${customer.id}`} className="hover:underline">{customer.name} ({customer.customer_number})</Link> },
                  { label: "Contact", value: [current.contact_name, current.contact_email, current.contact_phone].filter(Boolean).join("\n") },
                  { label: "Job site", value: site },
                  { label: "Project", value: current.project_name },
                  { label: "Quote date", value: formatDate(current.quote_date) },
                  { label: "Valid until", value: formatDate(current.valid_until) },
                  { label: "Customer PO", value: current.customer_po || (customer.po_required ? <Badge tone="amber">Required — not entered</Badge> : "") },
                  { label: "Sales tax", value: current.tax_rate_bp ? formatBp(current.tax_rate_bp) : "None" },
                  { label: "Job instructions", value: current.job_instructions, wide: true },
                  { label: "Internal notes", value: current.internal_notes, wide: true },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={`Line items — revision ${current.version_no}`} />
            <QuoteLinesTable lines={lines} />
            <div className="flex justify-end border-t border-line px-5 py-3 sm:px-6">
              <dl className="w-full max-w-xs space-y-1 text-[15px]">
                <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd className="tabular">{formatCents(current.subtotal_cents)}</dd></div>
                {current.discount_cents > 0 && <div className="flex justify-between"><dt className="text-muted">Discounts</dt><dd className="text-green-800 tabular">-{formatCents(current.discount_cents)}</dd></div>}
                <div className="flex justify-between"><dt className="text-muted">Tax ({formatBp(current.tax_rate_bp)})</dt><dd className="tabular">{formatCents(current.tax_cents)}</dd></div>
                <div className="flex justify-between border-t-2 border-strong pt-1 text-lg font-black"><dt>Total</dt><dd className="tabular">{formatCents(current.total_cents)}</dd></div>
              </dl>
            </div>
          </Card>

          <Card>
            <CardHeader title="Emails and deliveries" description="Every attempt is recorded, including failures and previews." />
            {deliveries.length === 0 ? (
              <CardBody><p className="text-muted">Not sent yet.</p></CardBody>
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr><Th>When</Th><Th>Result</Th><Th>Recipients</Th><Th className="hidden md:table-cell">Revision / document</Th></tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => {
                      const v = versions.find((x) => x.id === d.quote_version_id);
                      const st = d.channel === "manual" ? { label: "Marked sent manually", tone: "green" as const } : DELIVERY_LABEL[d.status];
                      return (
                        <Tr key={d.id}>
                          <Td className="whitespace-nowrap">
                            {formatDateTime(d.created_at, timezone)}
                            <div className="text-sm text-muted">by {who(d.created_by)}</div>
                          </Td>
                          <Td>
                            <Badge tone={st.tone}>{st.label}</Badge>
                            {d.error_message && <div className="mt-1 text-sm text-red-800">{d.error_message}</div>}
                            {d.note && <div className="mt-1 text-sm text-muted">{d.note}</div>}
                          </Td>
                          <Td className="text-sm">
                            {d.to_addresses.join(", ") || "—"}
                            {d.cc_addresses.length > 0 && <div className="text-muted">cc {d.cc_addresses.join(", ")}</div>}
                          </Td>
                          <Td className="hidden text-sm md:table-cell">
                            {v && <Link href={`/quotes/${quote.id}/versions/${v.id}`} className="hover:underline">Revision {v.version_no}</Link>}
                            {d.documents && <div className="font-mono text-xs text-muted" title={d.documents.sha256}>{d.documents.filename} · {d.documents.sha256.slice(0, 12)}</div>}
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

        <div className="space-y-5">
          <Card>
            <CardHeader title="Revisions" />
            <ul className="divide-y divide-line">
              {versions.map((v) => (
                <li key={v.id} className="px-5 py-3 sm:px-6">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/quotes/${quote.id}/versions/${v.id}`} className="font-semibold hover:text-brand-fg hover:underline">
                      Revision {v.version_no}
                    </Link>
                    <span className="font-semibold tabular">{formatCents(v.total_cents)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted">
                    {v.sent_at ? <Badge tone="green">Sent {formatDate(v.sent_at.slice(0, 10))}</Badge> : v.locked_at ? <Badge tone="dark">Issued</Badge> : <Badge>Draft</Badge>}
                    {quote.accepted_version_id === v.id && <Badge tone="green">Accepted</Badge>}
                    {v.id === quote.current_version_id && <Badge tone="blue">Current</Badge>}
                  </div>
                  {v.revision_reason && <p className="mt-1 text-sm text-muted">{v.revision_reason}</p>}
                  <div className="mt-1 flex gap-3 text-sm">
                    <Link href={`/quotes/${quote.id}/versions/${v.id}`} className="text-muted hover:text-ink hover:underline">View</Link>
                    <a href={`/quotes/${quote.id}/versions/${v.id}/pdf?download=1`} className="text-muted hover:text-ink hover:underline">PDF</a>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="History" />
            <ol className="space-y-0 px-5 py-3 sm:px-6">
              {events.map((e) => (
                <li key={e.id} className="relative border-l-2 border-line pb-4 pl-4 last:pb-0">
                  <span className="absolute top-1 -left-[5px] size-2 rounded-full bg-strong" aria-hidden />
                  <p className="text-sm font-semibold">
                    {e.from_status ? `${QUOTE_STATUS_LABELS[e.from_status]} → ` : ""}
                    {QUOTE_STATUS_LABELS[e.to_status]}
                  </p>
                  {e.note && <p className="text-sm">{e.note}</p>}
                  <p className="text-xs text-muted">
                    {formatDateTime(e.occurred_at, timezone)} · {who(e.actor_id)}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
    </>
  );
}
