import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { SupportForm } from "@/components/portal/portal-forms";
import { supportDefaults, ticketOptionLabel, ticketOptions, type PortalOrder, type PortalOrderSummary, type PortalTicketOption } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";
import { createClient } from "@/server/supabase/server";

export const metadata = { title: "New Support Request" };

const UUID = /^[0-9a-f-]{36}$/;

export default async function NewSupportRequest({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ order?: string; ticket?: string; invoice?: string }> }) {
  const { slug } = await params;
  const { order, ticket, invoice } = await searchParams;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/support/new`);
  if (!c.features.support) notFound();
  const orders = c.features.orders ? await portalCall<PortalOrderSummary[]>("portal_orders", { p_slug: slug }) : [];
  // Tickets and invoices to link (B138); none before that update is installed.
  const { data: linkData } = await (await createClient()).rpc("portal_support_link_options", { p_slug: slug });
  const links = (linkData ?? { tickets: [], invoices: [] }) as { tickets: PortalTicketOption[]; invoices: Array<{ id: string; label: string }> };
  // Every ticket shows its delivery day and quantity in the picker ("TKT-1025 · Nov 8 · 14.1 Tons"): from the picker's
  // own data since 20261120011500. Before that update only the tickets of the order it was opened from had them (from
  // portal_order), so those are still used where the picker's data has none. A refused order leaves the labels as they are.
  const fromOrder = order && UUID.test(order) && c.features.orders ? await (await createClient()).rpc("portal_order", { p_slug: slug, p_order: order }) : null;
  const detail = new Map(((fromOrder && !fromOrder.error ? (fromOrder.data as PortalOrder | null)?.tickets : null) ?? []).map((t) => [t.id, ticketOptionLabel(t, c.timezone)]));
  const tickets = ticketOptions(links.tickets, c.timezone).map((t, i) => ({ id: t.id, label: links.tickets[i].delivered_at ? t.label : detail.get(t.id) ?? t.label }));
  // The topic and subject a case opened from a ticket, an invoice or an order starts with; the customer can change both.
  const defaultOrder = orders.some((o) => o.id === order) ? order : undefined;
  const defaultTicket = c.features.orders && links.tickets.some((t) => t.id === ticket) ? ticket : undefined;
  const defaultInvoice = links.invoices.some((i) => i.id === invoice) ? invoice : undefined;
  const start = supportDefaults({
    ticket: links.tickets.find((t) => t.id === defaultTicket)?.label,
    invoice: links.invoices.find((i) => i.id === defaultInvoice)?.label,
    order: orders.find((o) => o.id === defaultOrder)?.number,
  });
  return (
    <div className="space-y-4">
      <p className="text-sm"><Link href={`/portal/${slug}/support`} className="text-muted hover:text-ink hover:underline">← Support</Link></p>
      <div>
        <h1 className="text-2xl font-bold text-ink">New support request</h1>
        <p className="mt-1 text-sm text-muted">Goes to {c.name}. You will see the reply here.</p>
      </div>
      <Card>
        <CardBody>
          <SupportForm slug={slug} orders={orders.slice(0, 50).map((o) => ({ id: o.id, number: o.number }))} defaultOrder={defaultOrder} defaultTicket={defaultTicket} defaultInvoice={defaultInvoice}
            defaultKind={start.kind} defaultSubject={start.subject} tickets={c.features.orders ? tickets : []} invoices={links.invoices} />
        </CardBody>
      </Card>
    </div>
  );
}
