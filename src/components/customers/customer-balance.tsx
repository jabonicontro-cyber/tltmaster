import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { balanceCents, invoiceState, STATE_LABEL } from "@/lib/billing/invoices";
import { getCustomerBalance } from "@/server/data/billing-balance";

/**
 * What this customer owes and what is still on its way to an invoice (UX10; first-day office walkthrough 2026-11-09:
 * a customer with delivered work and no invoice showed nothing). Always shown to people who see billing: owed on
 * issued invoices (and overdue), handed off but not invoiced, delivered but not billed yet (an estimate, labelled),
 * open on billed tickets where QuickBooks issues the invoices, and credit not applied.
 */
export async function CustomerBalance({ customerId, today }: { customerId: string; today: string }) {
  const b = await getCustomerBalance(customerId, today);
  const s = b.summary;
  const taviron = b.issuer === "taviron";
  const showInvoices = taviron || b.invoices.length > 0;
  return (
    <Card>
      <CardHeader
        title="Balance"
        description="What this customer owes, and delivered work that is not invoiced yet."
        actions={
          <span className="flex flex-wrap gap-3 text-sm font-semibold">
            <Link href={`/billing?customer=${customerId}`} className="text-brand-fg hover:underline">Billing</Link>
            {showInvoices && <Link href="/billing/invoices" className="text-brand-fg hover:underline">All invoices</Link>}
          </span>
        }
      />
      <CardBody className="space-y-4">
        {s.empty ? (
          <p className="text-sm text-muted">Nothing is owed and nothing is waiting to be billed.</p>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-label="Balance">
            {showInvoices && (
              <Figure label="Owed on issued invoices" value={formatCents(s.owedCents)}>
                {s.overdueCents > 0 ? <span className="font-semibold text-critical">{formatCents(s.overdueCents)} overdue</span> : "Nothing overdue"}
              </Figure>
            )}
            {!showInvoices && (
              <Figure label="Owed on invoices" value="In QuickBooks">QuickBooks issues your invoices, so what is owed on them is kept there.</Figure>
            )}
            <Figure label={taviron ? "Handed off, not invoiced yet" : "Handed off to accounting"} value={formatCents(s.handedOffCents)} muted={s.handedOffCount === 0}>
              {s.handedOffCount === 0 ? "None waiting" : taviron
                ? <>{s.handedOffCount} order{s.handedOffCount === 1 ? "" : "s"}: <Link href="/billing?view=handed_off" className="font-semibold text-brand-fg hover:underline">create the invoice</Link></>
                : `${s.handedOffCount} order${s.handedOffCount === 1 ? "" : "s"} billed from the handoff file or QuickBooks`}
            </Figure>
            <Figure label="Delivered, not billed yet" value={formatCents(s.deliveredCents)} muted={s.deliveredOrders === 0}>
              {s.deliveredOrders === 0 ? "None waiting" : (
                <>
                  Estimate: accepted tickets at the order&apos;s prices, on {s.deliveredOrders} order{s.deliveredOrders === 1 ? "" : "s"} in billing review.
                  {s.ticketsPending > 0 && ` ${s.ticketsPending} ticket${s.ticketsPending === 1 ? " is" : "s are"} not accepted yet and not counted.`}
                </>
              )}
            </Figure>
            {s.ticketsOpenCents !== null && (
              <Figure label="Open on billed tickets" value={formatCents(s.ticketsOpenCents)} muted={s.ticketsOpenCents === 0}>
                After payments recorded by ticket in Taviron; payments entered only in QuickBooks are not seen here.
              </Figure>
            )}
            {s.creditCents > 0 && (
              <Figure label="Credit not applied" value={formatCents(s.creditCents)}>
                Money received and not matched to a ticket yet: <Link href={`/billing/payments?customer=${customerId}`} className="font-semibold text-brand-fg hover:underline">apply it</Link>.
              </Figure>
            )}
          </dl>
        )}

        {(b.delivered.length > 0 || b.waiting.length > 0) && (
          <ul className="divide-y divide-line border-t border-line" aria-label="Not invoiced yet">
            {b.waiting.map((w) => (
              <li key={`w-${w.order_id}`}>
                <Link href={w.invoice ? `/billing/invoices/${w.invoice.id}` : `/billing/orders/${w.order_id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm hover:bg-surface">
                  <span className="font-semibold tabular">{w.order_number}<span className="ml-2 font-normal text-muted">{w.invoice ? "draft invoice, not issued" : taviron ? "handed off, no invoice yet" : "handed off"}</span></span>
                  <span className="tabular">{formatCents(w.total_cents)}</span>
                </Link>
              </li>
            ))}
            {b.delivered.map((d) => (
              <li key={`d-${d.order_id}`}>
                <Link href={`/billing/orders/${d.order_id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm hover:bg-surface">
                  <span className="font-semibold tabular">{d.order_number}<span className="ml-2 font-normal text-muted">in billing review{d.tickets_pending ? `, ${d.tickets_pending} ticket${d.tickets_pending === 1 ? "" : "s"} to check` : ""}</span></span>
                  <span className="tabular">{d.value_cents ? `${formatCents(d.value_cents)} so far` : "–"}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {b.invoices.length > 0 && (
          <ul className="divide-y divide-line border-t border-line" aria-label="Latest invoices">
            {b.invoices.slice(0, 5).map((r) => {
              const st = STATE_LABEL[invoiceState(r, today)];
              return (
                <li key={r.id}>
                  <Link href={`/billing/invoices/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm hover:bg-surface">
                    <span className="font-semibold tabular">{r.number}<span className="ml-2 font-normal text-muted">{r.issue_date ? formatDate(r.issue_date) : ""}{r.due_date ? ` · due ${formatDate(r.due_date)}` : ""}{r.status === "issued" && !r.sent_at ? " · not sent" : ""}</span></span>
                    <span className="flex items-center gap-2 tabular">{formatCents(balanceCents(r))}<Badge tone={st.tone}>{st.label}</Badge></span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function Figure({ label, value, muted, children }: { label: string; value: string; muted?: boolean; children?: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn("text-2xl font-semibold tabular", muted && "text-muted")}>{value}</dd>
      {children && <dd className="mt-0.5 text-xs text-muted">{children}</dd>}
    </div>
  );
}
