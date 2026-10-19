import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { SupportReplyForm } from "@/components/portal/portal-forms";
import { cn } from "@/lib/cn";
import { SUPPORT_STATUS_LABEL, type PortalThread } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Support Request" };

const UUID = /^[0-9a-f-]{36}$/;
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
          {t.order_number ? <p className="mt-1 text-sm text-muted">Order {t.order_number}</p> : null}
        </div>
        <Badge tone={t.status === "answered" ? "green" : t.status === "open" ? "brand" : "gray"}>{SUPPORT_STATUS_LABEL[t.status]}</Badge>
      </div>
      {sent ? <p role="status" className="rounded-md bg-surface p-3 text-sm text-ink">Sent. {c.name} will reply here.</p> : null}
      <ol className="space-y-3">
        {t.messages.map((m, i) => (
          <li key={i} className={cn("max-w-[42rem] rounded-lg border p-3", m.from === "customer" ? "ml-auto border-line bg-card" : "border-brand/30 bg-brand-light")}>
            <p className="mb-1 text-xs font-semibold text-muted">{m.from === "customer" ? "You" : c.name} · {WHEN.format(new Date(m.at))}</p>
            <p className="text-sm whitespace-pre-line text-ink">{m.body}</p>
          </li>
        ))}
      </ol>
      {t.status !== "closed" ? (
        <Card>
          <CardBody>
            <SupportReplyForm slug={slug} request={t.id} />
          </CardBody>
        </Card>
      ) : (
        <p className="text-sm text-muted">This request is closed. Start a new one if you need more help.</p>
      )}
    </div>
  );
}
