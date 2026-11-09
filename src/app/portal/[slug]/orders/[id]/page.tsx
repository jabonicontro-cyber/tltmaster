import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDay, formatMoment, formatMoney, formatQuantity, formatTime, portalIsPast, portalStatusLabel, scheduleText, type PortalOrder } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";
import { ReleasePortalTruck } from "@/components/portal/portal-forms";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "Order" };

const UUID = /^[0-9a-f-]{36}$/;

export default async function PortalOrderPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/orders/${id}`);
  if (!c.features.orders || !UUID.test(id)) notFound();
  const o = await portalCall<PortalOrder>("portal_order", { p_slug: slug, p_order: id });
  const loads = o.loads.filter((l) => !l.canceled);
  const today = new Date().toISOString().slice(0, 10);
  // Trucks working for the day on this order today (UX11); empty for other orders or before 20261120008600.
  const trucksRes = await (await createClient()).rpc("portal_order_trucks", { p_slug: slug, p_order: id });
  const trucks = (trucksRes.error ? [] : trucksRes.data ?? []) as Array<{ load_id: string; truck: string; start: string; end: string; released_at: string | null; started: boolean; trips: number }>;
  return (
    <div className="space-y-5">
      <p className="text-sm"><Link href={`/portal/${slug}/orders`} className="text-muted hover:text-ink hover:underline">← Orders</Link></p>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Order {o.number}</h1>
          <p className="mt-1 text-sm text-muted">{[o.project, o.site, o.po ? `PO ${o.po}` : ""].filter(Boolean).join(" · ")}</p>
        </div>
        {/* The same status as the Orders list ("Delivered" once finished but not closed yet). */}
        <Badge tone={o.status === "canceled" ? "gray" : o.status === "on_hold" ? "amber" : portalIsPast(o, today) ? "green" : "brand"} className="text-sm">{portalStatusLabel(o, today)}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
              <li key={i} className="py-2">
                <div className="flex justify-between gap-3"><span className="text-ink">{l.description}</span><span className="tabular text-muted">{formatQuantity(l.quantity, l.unit)}</span></div>
                {l.tracked && l.quantity !== null && o.status !== "canceled" ? <LineProgress line={l} /> : null}
              </li>
            ))}
          </ul>
          {o.total_cents ? <p className="mt-3 text-right text-sm font-semibold text-ink">Order total {formatMoney(o.total_cents)}</p> : null}
          {o.instructions ? <p className="mt-3 whitespace-pre-line text-sm text-muted">{o.instructions}</p> : null}
        </CardBody>
      </Card>

      {trucks.length > 0 && (
        <Card>
          <CardHeader title="Trucks Today" description="Trucks working for the day on this job. Release a truck when you no longer need it; its time stops then." />
          <CardBody>
            <ul className="divide-y divide-line text-sm">
              {trucks.map((t) => (
                <li key={t.load_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-ink">Truck {t.truck} · from {formatTime(t.start)} · <span className="tabular">{t.trips} {t.trips === 1 ? "trip" : "trips"}</span></span>
                  {t.released_at ? <Badge tone="green">Released {formatMoment(t.released_at, c.timezone, false)}</Badge>
                    : t.started ? <ReleasePortalTruck slug={slug} order={id} load={t.load_id} truck={t.truck} />
                    : <span className="text-muted">Starts at {formatTime(t.start)}</span>}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

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
                      <span className="text-ink">Ticket {t.number} · {formatMoment(t.delivered_at, c.timezone)}</span>
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
                <li key={i} className="flex justify-between gap-3"><span className="text-ink">{h.label}</span><span className="text-muted">{formatMoment(h.at, c.timezone)}</span></li>
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
    <div className="rounded-panel border border-line/70 bg-card shadow-card p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 font-semibold text-ink">{value}</p>
    </div>
  );
}

/** Delivered and left for one ordered line, from its delivery tickets in the line's own unit. */
function LineProgress({ line }: { line: PortalOrder["lines"][number] }) {
  const delivered = Number(line.delivered ?? 0);
  const confirmed = Number(line.confirmed ?? 0);
  const ordered = Number(line.quantity ?? 0);
  const checking = delivered - confirmed;
  const pct = ordered > 0 ? Math.min(100, Math.round((delivered / ordered) * 100)) : 0;
  const over = delivered > ordered;
  return (
    <div className="mt-1.5 space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface" aria-hidden>
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted tabular">
        {delivered > 0 ? `${formatQuantity(delivered, line.unit)} delivered` : "Nothing delivered yet"}
        {checking > 0 ? ` (${formatQuantity(checking, line.unit)} being checked)` : ""}
        {" · "}
        {over ? `${formatQuantity(delivered - ordered, line.unit)} over the order` : `${formatQuantity(line.remaining ?? ordered - delivered, line.unit)} left`}
      </p>
    </div>
  );
}
