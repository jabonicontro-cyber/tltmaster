import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { QuoteResponseForm } from "@/components/portal/portal-forms";
import { formatDay, formatMoney, formatQuantity, QUOTE_STATUS_LABEL, type PortalQuote } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Quote" };

const UUID = /^[0-9a-f-]{36}$/;

export default async function PortalQuotePage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/quotes/${id}`);
  if (!c.features.quotes || !UUID.test(id)) notFound();
  const q = await portalCall<PortalQuote>("portal_quote", { p_slug: slug, p_quote: id });
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href={`/portal/${slug}/quotes`} className="text-muted hover:text-ink hover:underline">← Quotes</Link></p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Quote {q.number}</h1>
          <p className="mt-1 text-sm text-muted">
            {[q.project, q.site, q.quote_date ? `Dated ${formatDay(q.quote_date)}` : "", q.valid_until ? `Valid until ${formatDay(q.valid_until)}` : ""].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Badge tone={q.status === "accepted" ? "green" : q.status === "sent" ? "brand" : "gray"} className="text-sm">{QUOTE_STATUS_LABEL[q.status]}</Badge>
      </div>

      <Card>
        <CardBody>
          <table className="w-full text-sm">
            <caption className="sr-only">Quote lines</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted"><th className="py-2 font-semibold">Item</th><th className="py-2 text-right font-semibold">Quantity</th><th className="py-2 text-right font-semibold">Amount</th></tr>
            </thead>
            <tbody>
              {q.lines.map((l, i) => (
                <tr key={i} className="border-b border-line"><td className="py-2 text-ink">{l.description}</td><td className="tabular py-2 text-right text-muted">{formatQuantity(l.quantity, l.unit)}</td><td className="tabular py-2 text-right text-ink">{formatMoney(l.amount_cents)}</td></tr>
              ))}
            </tbody>
            <tfoot className="text-right">
              {q.discount_cents ? <tr><td colSpan={2} className="pt-2 text-muted">Discount</td><td className="tabular pt-2">−{formatMoney(Math.abs(q.discount_cents))}</td></tr> : null}
              {q.tax_cents ? <tr><td colSpan={2} className="pt-1 text-muted">Tax</td><td className="tabular pt-1">{formatMoney(q.tax_cents)}</td></tr> : null}
              <tr><td colSpan={2} className="pt-2 font-semibold text-ink">Total</td><td className="tabular pt-2 font-semibold text-ink">{formatMoney(q.total_cents)}</td></tr>
            </tfoot>
          </table>
          {q.terms ? <p className="mt-4 whitespace-pre-line text-sm text-muted">{q.terms}</p> : null}
        </CardBody>
      </Card>

      {q.response ? (
        <p className="rounded-md bg-surface p-3 text-sm text-ink">
          {q.response.response === "accept" ? "You accepted" : "You declined"} this quote on {formatDay(q.response.at)} ({q.response.name}).{" "}
          {q.response.status === "pending" ? `${c.name} will confirm shortly.` : q.response.status === "confirmed" ? "Confirmed." : ""}
        </p>
      ) : null}

      {q.can_respond ? (
        <Card>
          <CardHeader title="Answer This Quote" description={`${c.name} confirms your answer before anything is scheduled.`} />
          <CardBody>
            <QuoteResponseForm slug={slug} quote={q.id} />
          </CardBody>
        </Card>
      ) : q.status === "sent" && !q.response ? (
        <p className="text-sm text-muted">This quote has expired. Request a new one from the Quotes page.</p>
      ) : null}
    </div>
  );
}
