import Link from "next/link";
import { notFound } from "next/navigation";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";
import { formatDay, type PortalInvoice } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";
import { PrintButton } from "@/components/portal/print-button";

export const metadata = { title: "Invoice" };

const UUID = /^[0-9a-f-]{36}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** One issued invoice for the customer (UX5): printable, read-only. */
export default async function PortalInvoicePage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/invoices/${id}`);
  if (!c.features.invoices || !UUID.test(id)) notFound();
  const i = await portalCall<PortalInvoice>("portal_invoice", { p_slug: slug, p_invoice: id });
  const b = i.bill_to ?? {};
  const from = i.issued_by ?? {};
  return (
    <div className="force-light space-y-4">
      <p className="text-sm print:hidden"><Link href={`/portal/${slug}/invoices`} className="text-muted hover:text-ink hover:underline">← Invoices</Link></p>
      <article className="rounded-panel border border-line/70 bg-card p-6 shadow-card print:border-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-ink">Invoice {i.number}</h1>
            <p className="text-sm text-muted">{str(from.name) || c.name}</p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Issued</dt><dd className="text-right tabular">{formatDay(i.issue_date)}</dd>
            <dt className="text-muted">Due</dt><dd className="text-right tabular">{formatDay(i.due_date)}</dd>
            {i.terms_days !== null && <><dt className="text-muted">Terms</dt><dd className="text-right">{i.terms_days === 0 ? "Due on receipt" : `Net ${i.terms_days}`}</dd></>}
          </dl>
        </header>
        <div className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="font-semibold text-ink">Bill to</p>
            <p className="whitespace-pre-line text-muted">{[str(b.name), str(b.line1), str(b.line2), [str(b.city), str(b.state), str(b.postal_code)].filter(Boolean).join(" ")].filter(Boolean).join("\n")}</p>
          </div>
          <div className="space-y-0.5 text-muted">
            {i.order_number && <p>Order {i.order_number}</p>}
            {i.customer_po && <p>PO {i.customer_po}</p>}
            {i.project_name && <p>{i.project_name}</p>}
            {i.service_start && <p>Service {formatDay(i.service_start)}{i.service_end && i.service_end !== i.service_start ? ` – ${formatDay(i.service_end)}` : ""}</p>}
          </div>
        </div>
        <table className="mt-5 w-full text-sm">
          <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="py-2 font-medium">Description</th><th className="py-2 text-right font-medium">Quantity</th><th className="py-2 text-right font-medium">Rate</th><th className="py-2 text-right font-medium">Amount</th></tr></thead>
          <tbody>
            {i.lines.map((l, n) => (
              <tr key={n} className="border-b border-line/60">
                <td className="py-2 pr-3 text-ink">{l.description}</td>
                <td className="py-2 text-right tabular">{l.quantity != null ? `${trimNumber(String(l.quantity))} ${(l.unit_code ?? "").replace(/_/g, " ")}` : ""}</td>
                <td className="py-2 text-right tabular">{l.unit_rate_cents != null ? formatCents(l.unit_rate_cents) : ""}</td>
                <td className="py-2 text-right font-medium tabular">{formatCents(l.amount_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-4 ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
          <dt className="text-muted">Subtotal</dt><dd className="text-right tabular">{formatCents(i.subtotal_cents)}</dd>
          {i.discount_cents ? <><dt className="text-muted">Discount</dt><dd className="text-right tabular">−{formatCents(i.discount_cents)}</dd></> : null}
          {i.tax_cents ? <><dt className="text-muted">Tax</dt><dd className="text-right tabular">{formatCents(i.tax_cents)}</dd></> : null}
          <dt className="font-semibold text-ink">Total</dt><dd className="text-right font-semibold tabular">{formatCents(i.total_cents)}</dd>
          {i.payments.flatMap((p, n) => [<dt key={`l${n}`} className="text-muted">Paid {formatDay(p.received_on)}</dt>, <dd key={`v${n}`} className="text-right tabular">−{formatCents(p.amount_cents)}</dd>])}
          <dt className="font-semibold text-ink">Balance</dt><dd className="text-right font-semibold tabular">{formatCents(i.balance_cents)}</dd>
        </dl>
        {i.footer && <p className="mt-5 text-sm whitespace-pre-line text-muted">{i.footer}</p>}
      </article>
      <div className="print:hidden"><PrintButton /></div>
    </div>
  );
}
