import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { formatDay, SUPPORT_STATUS_LABEL, type PortalSupportRow } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Support" };

export default async function PortalSupport({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/support`);
  if (!c.features.support) notFound();
  const rows = await portalCall<PortalSupportRow[]>("portal_support_list", { p_slug: slug });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-bold text-ink">Support</h1>
        <Link href={`/portal/${slug}/support/new`} className={buttonClasses("primary")}>New Request</Link>
      </div>
      {rows.length ? (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/portal/${slug}/support/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-card p-4 hover:border-strong focus-visible:outline-2 focus-visible:outline-strong">
                <span>
                  <span className="block font-semibold text-ink">{r.subject}</span>
                  <span className="block text-sm text-muted">{r.order_number ? `Order ${r.order_number} · ` : ""}Updated {formatDay(r.updated_at)}</span>
                </span>
                <Badge tone={r.status === "answered" ? "green" : r.status === "open" ? "brand" : "gray"}>{SUPPORT_STATUS_LABEL[r.status]}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No requests yet" description={`Questions about an order, a delivery or your account go straight to ${c.name}.`} />
      )}
    </div>
  );
}
