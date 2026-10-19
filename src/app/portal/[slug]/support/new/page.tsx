import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SupportForm } from "@/components/portal/portal-forms";
import type { PortalOrderSummary } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "New Support Request" };

export default async function NewSupportRequest({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ order?: string }> }) {
  const { slug } = await params;
  const { order } = await searchParams;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/support/new`);
  if (!c.features.support) notFound();
  const orders = c.features.orders ? await portalCall<PortalOrderSummary[]>("portal_orders", { p_slug: slug }) : [];
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href={`/portal/${slug}/support`} className="text-muted hover:text-ink hover:underline">← Support</Link></p>
      <Card>
        <CardHeader title="New Support Request" description={`Goes to ${c.name}. You will see the reply here.`} />
        <CardBody>
          <SupportForm slug={slug} orders={orders.slice(0, 50).map((o) => ({ id: o.id, number: o.number }))} defaultOrder={orders.some((o) => o.id === order) ? order : undefined} />
        </CardBody>
      </Card>
    </div>
  );
}
