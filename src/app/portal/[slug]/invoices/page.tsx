import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { formatCents } from "@/lib/money";
import { formatDay, type PortalInvoices } from "@/lib/portal";
import { portalCall, requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Invoices" };

const STATE = { open: { label: "Open", tone: "brand" }, overdue: { label: "Past due", tone: "amber" }, paid: { label: "Paid", tone: "green" } } as const;

/** The customer's invoices and their statement (UX5): read-only, from the invoices the company issued in Taviron. */
export default async function PortalInvoicesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = await requirePortalCustomer(slug, `/portal/${slug}/invoices`);
  if (!c.features.invoices) notFound();
  const data = await portalCall<PortalInvoices>("portal_invoices", { p_slug: slug });
  if (!data.enabled) notFound();
  const s = data.statement;
  const aging: Array<[string, number]> = [["Not yet due", s.current_cents], ["1–30 days past due", s.d1_30_cents], ["31–60 days", s.d31_60_cents], ["61–90 days", s.d61_90_cents], ["Over 90 days", s.d90_plus_cents]];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold text-ink">Invoices</h1>
      <section aria-label="Statement" className="rounded-panel border border-line/70 bg-card p-5 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">Statement</h2>
          <p className="text-sm text-muted">As of {formatDay(data.as_of)}</p>
        </div>
        <p className="mt-2 text-3xl font-semibold tracking-[-0.02em] tabular text-ink">{formatCents(s.balance_cents)}</p>
        <p className="text-sm text-muted">Balance on {s.open_count} open invoice{s.open_count === 1 ? "" : "s"}{s.overdue_cents > 0 ? ` · ${formatCents(s.overdue_cents)} past due` : ""}</p>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {aging.map(([label, cents]) => (
            <div key={label} className="rounded-xl bg-surface px-3 py-2">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="font-semibold tabular text-ink">{formatCents(cents)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted">Payments are recorded by {c.name} when received; questions about a charge can go through Support.</p>
      </section>
      {data.invoices.length === 0 ? (
        <EmptyState title="No invoices yet" description={`Invoices from ${c.name} appear here once they are issued.`} />
      ) : (
        <ul className="space-y-2" aria-label="Invoices">
          {data.invoices.map((i) => (
            <li key={i.id}>
              <Link href={`/portal/${slug}/invoices/${i.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line/70 bg-card p-4 shadow-card hover:border-strong">
                <span>
                  <span className="block font-semibold text-ink">Invoice {i.number}</span>
                  <span className="block text-sm text-muted">{[`Issued ${formatDay(i.issue_date)}`, `due ${formatDay(i.due_date)}`, i.order_number ? `Order ${i.order_number}` : "", i.customer_po ? `PO ${i.customer_po}` : ""].filter(Boolean).join(" · ")}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-right tabular">
                    <span className="block font-semibold text-ink">{formatCents(i.balance_cents)}</span>
                    <span className="block text-xs text-muted">of {formatCents(i.total_cents)}</span>
                  </span>
                  <Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
