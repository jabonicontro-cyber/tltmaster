import { FilePlus2 } from "lucide-react";
import { AdminFlash } from "@/components/admin/flash";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { combineCandidates, invoicingSettings } from "@/server/data/invoices";
import { createCombinedInvoice } from "../actions";

export const metadata = { title: "One invoice for several orders" };

const dates = (a: string | null, b: string | null) => (!a ? "" : b && b !== a ? `${formatDate(a)} – ${formatDate(b)}` : formatDate(a));

/**
 * One invoice for several orders (UX10, migration 20261120007000): for each customer with two or more handed-off
 * orders not invoiced yet, tick the orders to bill together. The result is a draft invoice; nothing is issued or sent.
 */
export default async function CombineInvoicesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const access = await requirePagePermission("billing.view");
  const sp = await searchParams;
  const [groups, settings] = await Promise.all([combineCandidates(), invoicingSettings()]);
  const manage = can(access, "billing.manage");
  const header = (
    <PageHeader
      title="One invoice for several orders"
      description="Bill a customer once for several handed-off orders, for example a job or a PO over a week. Each line names its order; totals add up. The result is a draft you check before issuing."
      crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices", href: "/billing/invoices" }, { label: "Several orders" }]}
      actions={<ButtonLink href="/billing?view=handed_off" variant="secondary">Handed-off orders</ButtonLink>}
    />
  );
  if (!groups || !settings.installed) {
    return <>{header}<Notice title="Not available yet">This needs a database update that has not been installed yet.</Notice></>;
  }
  if (settings.issuer !== "taviron") {
    return <>{header}<Notice title="Your invoices are issued in QuickBooks">To issue invoices from Taviron, change it in Settings → Invoicing.</Notice></>;
  }
  return (
    <>
      {header}
      <AdminFlash error={sp.error} />
      {groups.length === 0 ? (
        <EmptyState title="No customer has several orders to invoice" description="When a customer has two or more handed-off orders without an invoice, they appear here." />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
            const total = g.orders.reduce((n, o) => n + o.total_cents, 0);
            return (
              <Card key={g.customerId}>
                <CardHeader title={g.customerName} description={`${g.orders.length} handed-off orders not invoiced · ${formatCents(total)} in all`} />
                <form action={createCombinedInvoice} aria-label={`Orders of ${g.customerName}`}>
                  <ul className="divide-y divide-line border-t border-line">
                    {g.orders.map((o) => (
                      <li key={o.handoff_order_id}>
                        <label className="flex cursor-pointer items-start gap-3 px-5 py-3 sm:px-6">
                          <input type="checkbox" name="handoff" value={o.handoff_order_id} defaultChecked disabled={!manage} className="mt-1 size-4 shrink-0 rounded border-line accent-brand" aria-label={`Order ${o.order_number}`} />
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold tabular text-ink">{o.order_number}</span>
                            <span className="block text-sm text-muted">{[dates(o.service_start, o.service_end), o.customer_po ? `PO ${o.customer_po}` : "", o.project_name].filter(Boolean).join(" · ")}</span>
                          </span>
                          <span className="tabular text-ink">{formatCents(o.total_cents)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {manage && (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-6">
                      <p className="text-sm text-muted">Untick an order to leave it for another invoice.</p>
                      <SubmitButton pendingLabel="Creating…"><FilePlus2 className="size-4" />Create one draft invoice</SubmitButton>
                    </div>
                  )}
                </form>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
