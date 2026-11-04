import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { SupportReplyForm } from "@/components/portal/portal-forms";
import { cn } from "@/lib/cn";
import { formatMoment, SUPPORT_STATUS_LABEL, type PortalThread } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";
import { SUPPORT_KINDS, SUPPORT_REOPEN_DAYS } from "@/lib/support";

export const metadata = { title: "Support Request" };

const UUID = /^[0-9a-f-]{36}$/;

export default async function SupportThread({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ sent?: string }> }) {
  const { slug, id } = await params;
  const { sent } = await searchParams;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/support/${id}`);
  if (!c.features.support || !UUID.test(id)) notFound();
  const t = await portalCall<PortalThread>("portal_support_thread", { p_slug: slug, p_request: id });
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href={`/portal/${slug}/support`} className="text-muted hover:text-ink hover:underline">← Support</Link></p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">{t.subject}</h1>
          <p className="mt-1 text-sm text-muted">{[t.kind ? SUPPORT_KINDS[t.kind as keyof typeof SUPPORT_KINDS] : "", t.order_number ? `Order ${t.order_number}` : "", t.ticket_number ? `Ticket ${t.ticket_number}` : "", t.invoice_number ? `Invoice ${t.invoice_number}` : ""].filter(Boolean).join(" · ")}</p>
        </div>
        <Badge tone={t.status === "answered" ? "green" : t.status === "open" ? "brand" : "gray"}>{SUPPORT_STATUS_LABEL[t.status]}</Badge>
      </div>
      {sent ? <p role="status" className="rounded-xl bg-surface p-3 text-sm text-ink">Sent. {c.name} will reply here.</p> : null}
      <ol className="space-y-3">
        {t.messages.map((m, i) => (
          <li key={m.id ?? i} className={cn("max-w-[42rem] rounded-2xl border p-3", m.from === "customer" ? "ml-auto border-line bg-card" : "border-brand/30 bg-brand-light")}>
            <p className="mb-1 text-xs font-semibold text-muted">{m.from === "customer" ? "You" : c.name} · {formatMoment(m.at, c.timezone)}</p>
            <p className="text-sm whitespace-pre-line text-ink">{m.body}</p>
            {m.files?.length ? (
              <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attachments">
                {m.files.map((f) => (
                  <li key={f.id}><a href={`/portal/${slug}/support/files/${f.id}`} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-line bg-card px-2 py-1 text-xs font-medium text-ink hover:underline">{f.name}</a></li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      {t.status !== "closed" || t.can_reopen ? (
        <Card>
          <CardBody>
            {t.status === "closed" ? <p className="mb-3 text-sm text-muted">This request is closed. Writing here reopens it (for {SUPPORT_REOPEN_DAYS} days after it was closed).</p> : null}
            <SupportReplyForm slug={slug} request={t.id} />
          </CardBody>
        </Card>
      ) : (
        <p className="text-sm text-muted">This request was closed more than {SUPPORT_REOPEN_DAYS} days ago. <Link href={`/portal/${slug}/support/new`} className="font-semibold underline">Start a new one</Link> if you need more help.</p>
      )}
    </div>
  );
}
