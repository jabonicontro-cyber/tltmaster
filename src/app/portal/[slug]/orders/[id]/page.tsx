import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDay, formatMoney, formatQuantity, formatTime, scheduleText, type PortalOrder } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Order" };

const UUID = /^[0-9a-f-]{36}$/;
const DATETIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default async function PortalOrderPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/orders/${id}`);
  if (!c.features.orders || !UUID.test(id)) notFound();
  const o = await portalCall<PortalOrder>("portal_order", { p_slug: slug, p_order: id });
  const loads = o.loads.filter((l) => !l.canceled);
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href={`/portal/${slug}/orders`} className="text-muted hover:text-ink hover:underline">← Orders</Link></p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Order {o.number}</h1>
          <p className="mt-1 text-sm text-muted">{[o.project, o.site, o.po ? `PO ${o.po}` : ""].filter(Boolean).join(" · ")}</p>
        </div>
        <Badge tone={o.status === "canceled" ? "gray" : "brand"} className="text-sm">{o.status_label}</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Info label="Schedule" value={scheduleText(o) ?? (o.requested_date ? `Requested for ${formatDay(o.requested_date)}` : "Not scheduled yet")} />
        <Info label="Next delivery" value={o.next_load ? `${formatDay(o.next_load.date)}${o.next_load.start ? `, ${formatTime(o.next_load.start)}` : ""}` : "None planned"} />
        <Info label="Delivered" value={o.tickets_confirmed ? `${o.tickets_confirmed} confirmed (${formatQuantity(o.quantity_confirmed)})` : o.tickets_reported ? `${o.tickets_reported} being checked` : "Nothing yet"} />
      </div>
      <p className="text-xs text-muted">Times are planned delivery windows, not live arrival estimates. A delivery shows as confirmed once its ticket has been checked.</p>

      <Card>
        <CardHeader title="What Was Ordered" />
        <CardBody>
          <ul className="divide-y divide-line text-sm">
            {o.lines.map((l, i) => (
              <li key={i} className="flex justify-between gap-3 py-2"><span className="text-ink">{l.description}</span><span className="tabular text-muted">{formatQuantity(l.quantity, l.unit)}</span></li>
            ))}
          </ul>
          {o.total_cents ? <p className="mt-3 text-right text-sm font-semibold text-ink">Order total {formatMoney(o.total_cents)}</p> : null}
          {o.instructions ? <p className="mt-3 whitespace-pre-line text-sm text-muted">{o.instructions}</p> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Planned Deliveries" />
        <CardBody>
          {loads.length ? (
            <ul className="divide-y divide-line text-sm">
              {loads.map((l) => (
                <li key={l.number} className="flex flex-wrap justify-between gap-2 py-2">
                  <span className="text-ink">Load {l.number} · {formatDay(l.date)}{l.start ? `, ${formatTime(l.start)}${l.end ? `–${formatTime(l.end)}` : ""}` : ""}</span>
                  <span className="tabular text-muted">{formatQuantity(l.quantity, l.unit)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No deliveries are planned yet. We will schedule them before the delivery date.</p>
          )}
        </CardBody>
      </Card>

      {c.features.documents ? (
        <Card>
          <CardHeader title="Delivery Tickets" />
          <CardBody>
            {o.tickets.length ? (
              <ul className="divide-y divide-line text-sm">
                {o.tickets.map((t) => (
                  <li key={t.id}>
                    <Link href={`/portal/${slug}/orders/${o.id}/tickets/${t.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-surface">
                      <span className="text-ink">Ticket {t.number} · {DATETIME.format(new Date(t.delivered_at))}</span>
                      <span className="flex items-center gap-2"><span className="tabular text-muted">{formatQuantity(t.quantity, t.unit)}</span><Badge tone={t.confirmed ? "green" : "gray"}>{t.confirmed ? "Confirmed" : "Being checked"}</Badge></span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Tickets appear here after each delivery.</p>
            )}
          </CardBody>
        </Card>
      ) : null}

      {o.history.length ? (
        <Card>
          <CardHeader title="History" />
          <CardBody>
            <ol className="space-y-1 text-sm">
              {o.history.map((h, i) => (
                <li key={i} className="flex justify-between gap-3"><span className="text-ink">{h.label}</span><span className="text-muted">{DATETIME.format(new Date(h.at))}</span></li>
              ))}
            </ol>
          </CardBody>
        </Card>
      ) : null}

      {c.features.support ? (
        <p className="text-sm">
          Question about this order? <Link href={`/portal/${slug}/support/new?order=${o.id}`} className="font-semibold text-brand-fg hover:underline">Ask us</Link>
        </p>
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-semibold text-ink">{value}</p>
    </div>
  );
}
