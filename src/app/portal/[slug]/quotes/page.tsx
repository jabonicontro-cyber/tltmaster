import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { QuoteRequestForm } from "@/components/portal/portal-forms";
import { formatDay, formatMoney, formatQuantity, QUOTE_STATUS_LABEL, REQUEST_STATUS_LABEL, responseLabel, type PortalQuoteRequest, type PortalQuoteRow } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Quotes" };

export default async function PortalQuotes({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/quotes`);
  if (!c.features.quotes) notFound();
  const { quotes, requests } = await portalCall<{ quotes: PortalQuoteRow[]; requests: PortalQuoteRequest[] }>("portal_quotes", { p_slug: slug });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-ink">Quotes</h1>
      <Card>
        <CardHeader title="Your Quotes" description="Quotes we have sent you. Open one to read it and accept or decline." />
        <CardBody>
          {quotes.length ? (
            <ul className="divide-y divide-line">
              {quotes.map((q) => (
                <li key={q.id}>
                  <Link href={`/portal/${slug}/quotes/${q.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-surface focus-visible:outline-2 focus-visible:outline-strong">
                    <span>
                      <span className="block font-semibold text-ink">Quote {q.number}{q.project ? ` · ${q.project}` : ""}</span>
                      <span className="block text-sm text-muted">
                        {q.sent_at ? `Sent ${formatDay(q.sent_at)}` : ""}{q.valid_until ? ` · Valid until ${formatDay(q.valid_until)}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="tabular text-sm text-ink">{formatMoney(q.total_cents)}</span>
                      <Badge tone={q.status === "accepted" ? "green" : q.status === "sent" ? "brand" : "gray"}>{responseLabel(q.response) ?? QUOTE_STATUS_LABEL[q.status]}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No quotes yet. Request one below.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Request a Quote" description="Tell us what you need. We reply with a priced quote; nothing is ordered until you accept one." />
        <CardBody>
          <QuoteRequestForm slug={slug} sites={c.sites} />
        </CardBody>
      </Card>

      {requests.length ? (
        <Card>
          <CardHeader title="Your Requests" />
          <CardBody>
            <ul className="divide-y divide-line text-sm">
              {requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-ink">{r.material}{r.quantity ? ` · ${formatQuantity(r.quantity, r.unit)}` : ""}{r.requested_date ? ` · needed ${formatDay(r.requested_date)}` : ""}</span>
                  <span className="flex items-center gap-2 text-muted">
                    {r.quote_number ? `Quote ${r.quote_number}` : formatDay(r.created_at)}
                    <Badge tone={r.status === "quoted" ? "green" : r.status === "new" || r.status === "reviewing" ? "brand" : "gray"}>{REQUEST_STATUS_LABEL[r.status]}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
