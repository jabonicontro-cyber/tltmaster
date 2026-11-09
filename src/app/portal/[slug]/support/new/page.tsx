import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { SupportForm } from "@/components/portal/portal-forms";
import type { PortalOrderSummary } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "New Support Request" };

export default async function NewSupportRequest({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ order?: string; ticket?: string }> }) {
  const { slug } = await params;
  const { order, ticket } = await searchParams;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/support/new`);
  if (!c.features.support) notFound();
  const orders = c.features.orders ? await portalCall<PortalOrderSummary[]>("portal_orders", { p_slug: slug }) : [];
  // Tickets and invoices to link (B138); none before that update is installed.
  const { data: linkData } = await (await createClient()).rpc("portal_support_link_options", { p_slug: slug });
  const links = (linkData ?? { tickets: [], invoices: [] }) as { tickets: Array<{ id: string; label: string }>; invoices: Array<{ id: string; label: string }> };
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href={`/portal/${slug}/support`} className="text-muted hover:text-ink hover:underline">← Support</Link></p>
      <div>
        <h1 className="text-2xl font-bold text-ink">New support request</h1>
        <p className="mt-1 text-sm text-muted">Goes to {c.name}. You will see the reply here.</p>
      </div>
      <Card>
        <CardBody>
          <SupportForm slug={slug} orders={orders.slice(0, 50).map((o) => ({ id: o.id, number: o.number }))} defaultOrder={orders.some((o) => o.id === order) ? order : undefined} defaultTicket={ticket}
            tickets={c.features.orders ? links.tickets : []} invoices={links.invoices} />
        </CardBody>
      </Card>
    </div>
  );
}
