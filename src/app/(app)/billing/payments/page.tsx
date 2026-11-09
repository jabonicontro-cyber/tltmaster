import Link from "next/link";
import { TicketPaymentForm, VoidTicketPayment } from "@/components/billing/ticket-payment-form";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { SubmitButton } from "@/components/ui/submit-button";
import { EmptyState, Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/billing/invoices";
import { payableCents, ticketState } from "@/lib/billing/ticket-payments";
import { formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { businessToday } from "@/server/data/settings";
import { customerTicketBalances, ticketPaymentCustomers } from "@/server/data/ticket-payments";

export const metadata = { title: "Payments by ticket" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Payments by delivery ticket (TP1): for customers who pay against ticket numbers rather than an invoice. Money
 * received is applied to tickets (whole or part); what is not applied stays visible as the customer's credit.
 */
export default async function TicketPaymentsPage({ searchParams }: { searchParams: Promise<{ customer?: string; apply?: string }> }) {
  const access = await requirePagePermission("billing.view");
  const manage = can(access, "billing.manage");
  const sp = await searchParams;
  const customers = await ticketPaymentCustomers();

  const header = (
    <PageHeader
      title="Payments by ticket"
      description="For customers who pay against delivery ticket numbers instead of an invoice. Record what came in, match it to the tickets on the stub or remittance, and keep what is left as the customer's credit."
      actions={<ButtonLink href="/billing" variant="secondary" size="sm">Billing</ButtonLink>}
    />
  );

  if (customers === null) {
    return (
      <>
        {header}
        <Notice tone="warning" title="Not available yet">Payments by ticket need a database update (20261120009400) that has not been applied here yet.</Notice>
      </>
    );
  }

  const customerId = sp.customer && UUID.test(sp.customer) ? sp.customer : customers[0]?.id;
  const balances = customerId ? await customerTicketBalances(customerId) : null;
  const { today } = await businessToday();
  const applying = balances && sp.apply ? balances.payments.find((p) => p.id === sp.apply && !p.voided && p.unapplied_cents > 0) : undefined;
  const openCents = balances?.tickets.reduce((t, k) => t + payableCents(k), 0) ?? 0;
  const openCount = balances?.tickets.filter((k) => payableCents(k) > 0).length ?? 0;
  const settled = balances?.tickets.filter((k) => ticketState(k) !== "open" || payableCents(k) < k.open_cents) ?? [];
  const customerName = customers.find((c) => c.id === customerId)?.name;

  return (
    <>
      {header}
      {customers.length === 0 ? (
        <EmptyState title="No billed tickets yet" description="Tickets show here once their order is handed off to billing." action={<ButtonLink href="/billing" size="sm">Go to billing</ButtonLink>} />
      ) : (
        <div className="space-y-5">
          <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Choose a customer">
            <div>
              <label htmlFor="tp-customer" className="mb-1 block text-sm font-medium text-ink">Customer</label>
              <Select id="tp-customer" name="customer" defaultValue={customerId} className="min-w-64">
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <SubmitButton variant="secondary">Show</SubmitButton>
          </form>

          {!balances ? (
            <Notice tone="warning" title="Customer not found">Choose a customer from the list.</Notice>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Figure label="Open on tickets" value={formatCents(openCents)} />
                <Figure label="Open tickets" value={String(openCount)} />
                <Figure label="Credit not applied" value={formatCents(balances.unapplied_cents)} hint={balances.unapplied_cents > 0 ? "Apply it from the payments list below." : undefined} />
              </div>

              <Notice title={balances.issuer === "taviron" ? "Invoices follow the tickets" : "Recorded in Taviron"}>
                {balances.issuer === "taviron"
                  ? "Money applied to a ticket also pays the issued invoice it is on, so invoice balances, aging and the customer portal stay right. A ticket must be on an issued invoice first."
                  : "Payments are tracked here by ticket. Sending them to QuickBooks is not built yet, so record the payment in QuickBooks as well for now."}
              </Notice>

              {manage && (
                <Card>
                  <CardHeader
                    title={applying ? "Apply credit" : `Record a payment from ${customerName ?? "this customer"}`}
                    description={applying
                      ? `${formatCents(applying.unapplied_cents)} left from the ${PAYMENT_METHODS[applying.method as PaymentMethod] ?? "payment"}${applying.reference ? ` #${applying.reference}` : ""} received ${formatDate(applying.received_on)}.`
                      : "Choose the tickets it pays. A ticket can be paid in part; anything not applied is kept as credit."}
                    actions={applying ? <ButtonLink href={`/billing/payments?customer=${customerId}`} variant="ghost" size="sm">Record a new payment instead</ButtonLink> : undefined}
                  />
                  <CardBody>
                    <TicketPaymentForm
                      key={applying ? `apply-${applying.id}` : `record-${customerId}`}
                      mode={applying ? { kind: "apply", paymentId: applying.id, creditCents: applying.unapplied_cents } : { kind: "record", customerId: customerId!, today }}
                      tickets={balances.tickets}
                    />
                  </CardBody>
                </Card>
              )}

              {!manage && openCount > 0 && (
                <Card>
                  <CardHeader title="Open tickets" />
                  <CardBody className="text-sm text-muted">{openCount} {openCount === 1 ? "ticket is" : "tickets are"} open for {formatCents(openCents)}. Recording payments needs the billing manager permission.</CardBody>
                </Card>
              )}

              <Card>
                <CardHeader title="Payments" description="The latest 50, newest first. Voiding a payment (a bounced check, one entered twice) reopens its tickets." />
                {balances.payments.length === 0 ? (
                  <CardBody className="text-sm text-muted">No payments recorded for this customer yet.</CardBody>
                ) : (
                  <ul className="divide-y divide-line">
                    {balances.payments.map((p) => (
                      <li key={p.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-2">
                            <span className={p.voided ? "font-medium text-muted line-through" : "font-medium tabular-nums text-ink"}>{formatCents(p.amount_cents)}</span>
                            <span>{PAYMENT_METHODS[p.method as PaymentMethod] ?? p.method}{p.reference ? ` #${p.reference}` : ""}</span>
                            <span className="text-muted">received {formatDate(p.received_on)}</span>
                            {p.voided ? <Badge tone="gray">Voided</Badge> : p.unapplied_cents > 0 ? <Badge tone="amber">{formatCents(p.unapplied_cents)} credit</Badge> : <Badge tone="green">Applied</Badge>}
                          </p>
                          <p className="mt-1 text-muted">
                            {p.tickets.length === 0 ? "No tickets yet." : p.tickets.map((a) => `${a.ticket_number} ${formatCents(a.amount_cents)}`).join(" · ")}
                          </p>
                          {p.note && <p className="mt-1 text-muted">{p.note}</p>}
                          {p.voided && p.void_reason && <p className="mt-1 text-muted">Voided: {p.void_reason}</p>}
                        </div>
                        {manage && !p.voided && (
                          <div className="flex items-center gap-2">
                            {p.unapplied_cents > 0 && applying?.id !== p.id && (
                              <ButtonLink href={`/billing/payments?customer=${customerId}&apply=${p.id}`} variant="secondary" size="sm">Apply credit</ButtonLink>
                            )}
                            <VoidTicketPayment paymentId={p.id} />
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {settled.length > 0 && (
                <Card>
                  <CardHeader title="Paid and part-paid tickets" description="Paid counts money applied to the ticket and payments recorded on its invoice itself." />
                  <TableWrap className="rounded-none border-0">
                    <Table>
                      <thead>
                        <tr><Th>Ticket</Th><Th>Order</Th><Th>Invoice</Th><Th align="right">Billed</Th><Th align="right">Paid</Th><Th align="right">Open</Th></tr>
                      </thead>
                      <tbody>
                        {settled.map((t) => (
                          <Tr key={`${t.handoff_order_id}|${t.ticket_number}`}>
                            <Td className="font-medium">{t.ticket_number} <SettledBadge state={ticketState(t)} /></Td>
                            <Td className="text-muted">{t.order_number}</Td>
                            <Td className="text-muted">{t.invoice_number ?? (t.qbo_numbers.length ? `QuickBooks ${t.qbo_numbers.join(", ")}` : "–")}</Td>
                            <Td align="right" className="tabular-nums">{formatCents(t.billed_cents)}</Td>
                            <Td align="right" className="tabular-nums">{formatCents(Math.max(0, t.billed_cents - payableCents(t)))}</Td>
                            <Td align="right" className="tabular-nums">{formatCents(payableCents(t))}</Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  </TableWrap>
                </Card>
              )}

              <p className="text-xs text-muted">
                A ticket&apos;s amount is its share of the billed order: lines split by the ticket&apos;s quantity, with flat charges, tax and discounts spread across the order&apos;s tickets so they add up exactly. <Link href="/billing" className="underline underline-offset-2">Billing</Link> hands orders off.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}

function SettledBadge({ state }: { state: ReturnType<typeof ticketState> }) {
  if (state === "paid") return <Badge tone="green">Paid</Badge>;
  if (state === "invoice") return <Badge tone="green">Paid on the invoice</Badge>;
  return <Badge tone="amber">Part paid</Badge>;
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardBody className="space-y-1">
        <p className="text-sm text-muted">{label}</p>
        <p className="text-2xl font-semibold tabular-nums text-ink">{value}</p>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </CardBody>
    </Card>
  );
}
