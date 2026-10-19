import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { formatQuantity, scheduleText, type PortalOrderSummary } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Orders" };

export default async function PortalOrders({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ show?: string }> }) {
  const { slug } = await params;
  const { show } = await searchParams;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/orders`);
  if (!c.features.orders) notFound();
  const all = await portalCall<PortalOrderSummary[]>("portal_orders", { p_slug: slug });
  const past = show === "past";
  const orders = all.filter((o) => (["completed", "canceled"].includes(o.status) ? past : !past));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink">Orders</h1>
        <nav aria-label="Order filter" className="flex gap-1 text-sm">
          <Link href={`/portal/${slug}/orders`} aria-current={!past ? "page" : undefined} className={`rounded-md px-3 py-1.5 font-semibold ${!past ? "bg-strong text-white" : "text-muted hover:text-ink"}`}>Open</Link>
          <Link href={`/portal/${slug}/orders?show=past`} aria-current={past ? "page" : undefined} className={`rounded-md px-3 py-1.5 font-semibold ${past ? "bg-strong text-white" : "text-muted hover:text-ink"}`}>Delivered and Canceled</Link>
        </nav>
      </div>
      {orders.length === 0 ? (
        <EmptyState title={past ? "No past orders" : "No open orders"} description={past ? "Delivered and canceled orders appear here." : "Orders we have confirmed for you appear here."} />
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/portal/${slug}/orders/${o.id}`} className="block rounded-lg border border-line bg-card p-4 hover:border-strong focus-visible:outline-2 focus-visible:outline-strong">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-ink">Order {o.number}{o.materials ? ` · ${o.materials}` : ""}</p>
                    <p className="mt-0.5 text-sm text-muted">{scheduleText(o) ?? "Not scheduled yet"}{o.site ? ` · ${o.site}` : ""}</p>
                    {o.po ? <p className="mt-0.5 text-sm text-muted">PO {o.po}</p> : null}
                  </div>
                  <Badge tone={o.status === "canceled" ? "gray" : o.status === "on_hold" ? "amber" : "brand"}>{o.status_label}</Badge>
                </div>
                {o.tickets_confirmed + o.tickets_reported > 0 ? (
                  <p className="mt-2 text-sm text-ink">
                    {o.tickets_confirmed} {o.tickets_confirmed === 1 ? "delivery" : "deliveries"} confirmed{o.quantity_confirmed ? ` (${formatQuantity(o.quantity_confirmed)})` : ""}
                    {o.tickets_reported ? ` · ${o.tickets_reported} being checked` : ""}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
