import Link from "next/link";
import { notFound } from "next/navigation";
import { formatQuantity } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";
import { PrintButton } from "@/components/portal/print-button";

export const metadata = { title: "Delivery Ticket" };

const UUID = /^[0-9a-f-]{36}$/;
type Ticket = {
  number: string; delivered_at: string; quantity: number; unit: string; confirmed: boolean; reference: string; material: string | null;
  order: { number: string; site: string; project: string; po: string };
  company: { name: string; contact_phone: string; contact_email: string; logo: string };
  customer: string;
};

/** The customer's copy of one delivery ticket: printable, without driver, truck or internal review details. */
export default async function PortalTicket({ params }: { params: Promise<{ slug: string; id: string; ticketId: string }> }) {
  const { slug, id, ticketId } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/orders/${id}/tickets/${ticketId}`);
  if (!c.features.documents || !UUID.test(ticketId)) notFound();
  const t = await portalCall<Ticket>("portal_ticket", { p_slug: slug, p_ticket: ticketId });
  const delivered = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(t.delivered_at));
  return (
    <div className="space-y-4">
      <div className="no-print flex items-center justify-between gap-3 text-sm">
        <Link href={`/portal/${slug}/orders/${id}`} className="text-muted hover:text-ink hover:underline">← Order {t.order.number}</Link>
        <PrintButton />
      </div>
      <article className="force-light rounded-lg border border-line bg-card p-6 text-ink">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
          <div>
            <p className="text-lg font-bold">{t.company.name}</p>
            <p className="text-sm text-muted">{[t.company.contact_phone, t.company.contact_email].filter(Boolean).join(" · ")}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted">Delivery ticket</p>
            <p className="text-lg font-bold">{t.number}</p>
          </div>
        </header>
        <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Row label="Customer" value={t.customer} />
          <Row label="Order" value={t.order.number} />
          <Row label="Delivered" value={delivered} />
          <Row label="Site" value={t.order.site} />
          <Row label="Material" value={t.material ?? ""} />
          <Row label="Quantity" value={formatQuantity(t.quantity, t.unit)} />
          {t.order.po ? <Row label="PO" value={t.order.po} /> : null}
          {t.order.project ? <Row label="Project" value={t.order.project} /> : null}
          {t.reference ? <Row label="Reference" value={t.reference} /> : null}
          <Row label="Status" value={t.confirmed ? "Confirmed" : "Being checked by our office"} />
        </dl>
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value || "—"}</dd>
    </div>
  );
}
