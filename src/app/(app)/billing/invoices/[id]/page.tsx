import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, FileText } from "lucide-react";
import { AdminFlash } from "@/components/admin/flash";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DateInput } from "@/components/ui/date-input";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { PAYMENT_METHODS, STATE_LABEL, balanceCents, defaultInvoiceEmail, invoiceState, ordersWord, paidCents } from "@/lib/billing/invoices";
import { formatDate, formatDateTime } from "@/lib/dates";
import { trimNumber } from "@/lib/fleet/labels";
import { formatCents } from "@/lib/money";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { getInvoice, invoiceOrders, invoiceSender } from "@/server/data/invoices";
import { getUserNames } from "@/server/data/quotes";
import { businessToday } from "@/server/data/settings";
import { addPayment, issueInvoice, sendInvoice, voidInvoice, voidPayment } from "../actions";
import { IssueInvoiceForm } from "@/components/billing/issue-invoice-form";

export const metadata = { title: "Invoice" };

const SAVED: Record<string, string> = {
  created: "Draft invoice created from the handed-off order. Check it, then issue it.",
  issued: "Issued. The invoice is numbered and locked; send it or download the PDF.",
  sent: "Emailed to the customer with the PDF attached.",
  test_sent: "Test mode: the email went to the test inbox only and the invoice is not marked sent.",
  payment: "Payment recorded.",
  payment_voided: "Payment voided. It stays on record with your reason.",
  voided: "Invoice voided. It stays on record with its number and your reason.",
};

/** One invoice (B99): what it charges, its PDF with the company's branding, sending, payments and voiding. */
export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const access = await requirePagePermission("billing.view");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [inv, { today, timezone }, names, orders] = await Promise.all([getInvoice(id), businessToday(), getUserNames(), invoiceOrders(id)]);
  if (!inv) notFound();
  const sender = await invoiceSender(inv);
  const manage = can(access, "billing.manage");
  const state = invoiceState(inv, today);
  const owed = balanceCents(inv);
  const paid = paidCents(inv);
  const email = defaultInvoiceEmail(inv, formatCents(inv.total_cents), inv.due_date ? formatDate(inv.due_date) : "", sender.name);
  const b = inv.bill_to;

  return (
    <>
      <PageHeader
        title={inv.number ? `Invoice ${inv.number}` : "Draft invoice"}
        description={`${b.name} · ${ordersWord(inv.order_number)} ${inv.order_number}${inv.project_name ? ` · ${inv.project_name}` : ""}`}
        crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices", href: "/billing/invoices" }, { label: inv.number ?? "Draft" }]}
        badges={<Badge tone={STATE_LABEL[state].tone}>{STATE_LABEL[state].label}</Badge>}
        actions={
          <>
            <ButtonLink href={`/billing/invoices/${inv.id}/pdf`} variant="secondary" icon={<FileText className="size-4" />} target="_blank">View PDF</ButtonLink>
            <ButtonLink href={`/billing/invoices/${inv.id}/pdf?download=1`} variant="ghost" icon={<Download className="size-4" />}>Download</ButtonLink>
          </>
        }
      />
      {(sp.saved === "previewed" || sp.saved === "previewed_demo") && !sp.error ? (
        // A preview is not a success: nothing left Taviron and the invoice is still not marked sent.
        <div className="mb-4" role="status">
          <Notice title="Not sent: this was a preview only">
            {sp.saved === "previewed_demo" ? "Demo companies never send email." : "Email is not set up on this server, so nothing was emailed."} The invoice is still not marked as sent.
            {" "}To get it to the customer, download the PDF and mail or email it yourself.{sp.saved === "previewed_demo" ? " In a live company with email set up, Send invoice emails the PDF and marks it sent." : " Once email is set up, Send invoice emails the PDF and marks it sent."}
            {" "}Recording an invoice you sent yourself as sent is not available yet.
          </Notice>
        </div>
      ) : (
        <AdminFlash error={sp.error} saved={sp.saved} savedText={SAVED[sp.saved ?? ""] ?? "Saved."} />
      )}
      {inv.status === "void" && <div className="mb-4"><Notice tone="warning" title="Void">{inv.void_reason}</Notice></div>}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="What it charges" description="From the order as it was handed off for billing; later changes to the order do not change this invoice." />
            <TableWrap>
              <Table aria-label="Invoice lines">
                <thead><tr><Th>Description</Th><Th align="right" className="hidden sm:table-cell">Quantity</Th><Th align="right" className="hidden sm:table-cell">Rate</Th><Th align="right">Amount</Th></tr></thead>
                <tbody>
                  {inv.lines.map((l, i) => {
                    const qty = l.delivered_quantity ?? l.quantity;
                    return (
                      <Tr key={i}>
                        <Td>{l.description}</Td>
                        <Td align="right" className="hidden tabular sm:table-cell">{qty != null && l.calc_method !== "percent" ? `${trimNumber(String(qty))} ${l.unit_code ?? ""}` : ""}</Td>
                        <Td align="right" className="hidden tabular sm:table-cell">{l.unit_rate_cents != null && l.calc_method !== "percent" ? formatCents(Number(l.unit_rate_cents)) : ""}</Td>
                        <Td align="right" className="tabular">{formatCents(Number(l.amount_cents))}</Td>
                      </Tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableWrap>
            <dl className="ml-auto grid w-full max-w-xs grid-cols-2 gap-y-1 px-5 py-4 text-sm sm:px-6" aria-label="Totals">
              <dt className="text-muted">Subtotal</dt><dd className="text-right tabular">{formatCents(inv.subtotal_cents)}</dd>
              {inv.discount_cents ? <><dt className="text-muted">Discounts</dt><dd className="text-right tabular">−{formatCents(Math.abs(inv.discount_cents))}</dd></> : null}
              {inv.tax_cents ? <><dt className="text-muted">Tax</dt><dd className="text-right tabular">{formatCents(inv.tax_cents)}</dd></> : null}
              <dt className="font-semibold">Total</dt><dd className="text-right font-semibold tabular">{formatCents(inv.total_cents)}</dd>
              {paid ? <><dt className="text-muted">Paid</dt><dd className="text-right tabular">{formatCents(paid)}</dd></> : null}
              {inv.status === "issued" && <><dt className="font-semibold">Balance due</dt><dd className="text-right text-lg font-semibold tabular">{formatCents(owed)}</dd></>}
            </dl>
          </Card>

          {orders.length > 1 && (
            <Card>
              <CardHeader title={`${orders.length} orders on this invoice`} description="Each line above names its order." />
              <ul className="divide-y divide-line border-t border-line" aria-label="Orders on this invoice">
                {orders.map((o) => (
                  <li key={o.order_id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm sm:px-6">
                    <Link href={`/billing/orders/${o.order_id}`} className="font-semibold tabular hover:underline">{o.order_number}</Link>
                    <span className="tabular">{formatCents(o.total_cents)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {inv.status !== "draft" && (
            <Card>
              <CardHeader title="Payments" />
              {inv.payments.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-muted sm:px-6">No payments recorded.</p>
              ) : (
                <ul className="divide-y divide-line border-t border-line" aria-label="Payments">
                  {inv.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm sm:px-6">
                      <span className={p.voided_at ? "font-semibold tabular line-through" : "font-semibold tabular"}>{formatCents(p.amount_cents)}</span>
                      <span>{PAYMENT_METHODS[p.method]}{p.reference ? ` #${p.reference}` : ""}</span>
                      <span className="text-muted">received {formatDate(p.received_on)} · recorded by {p.recorded_by ? names[p.recorded_by] ?? "Former user" : "–"}</span>
                      {p.note && <span className="text-muted">· {p.note}</span>}
                      {p.voided_at ? (
                        <span className="w-full text-muted">Voided: {p.void_reason}</span>
                      ) : p.customer_payment_id ? (
                        // Paid by ticket (TP1): voided with its ticket payment, on Payments by ticket.
                        <Link href={`/billing/payments?customer=${inv.customer_id}`} className="ml-auto text-sm font-medium text-brand-fg underline-offset-2 hover:underline">Paid by ticket: change it on Payments by ticket</Link>
                      ) : manage ? (
                        <form action={voidPayment} className="ml-auto flex items-center gap-2">
                          <input type="hidden" name="invoice" value={inv.id} />
                          <input type="hidden" name="payment" value={p.id} />
                          <label className="sr-only" htmlFor={`vp-${p.id}`}>Reason to void this payment</label>
                          <Input id={`vp-${p.id}`} name="reason" placeholder="Reason to void" maxLength={300} className="h-8 w-44 text-sm" required />
                          <SubmitButton size="sm" variant="ghost">Void payment</SubmitButton>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardBody className="space-y-3 text-sm">
              <div>
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">Bill to</p>
                <p className="font-semibold">{b.name}</p>
                {[b.line1, b.line2, [b.city, [b.state, b.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter((l) => l && l.trim()).map((l) => <p key={l}>{l}</p>)}
                {b.email && <p className="text-muted">{b.email}</p>}
              </div>
              <dl className="grid grid-cols-2 gap-y-1">
                <dt className="text-muted">Issued</dt><dd className="tabular">{inv.issue_date ? formatDate(inv.issue_date) : "Not yet"}</dd>
                <dt className="text-muted">Due</dt><dd className={state === "overdue" ? "font-semibold text-critical tabular" : "tabular"}>{inv.due_date ? formatDate(inv.due_date) : `${inv.terms_days} days after issue`}</dd>
                <dt className="text-muted">Terms</dt><dd>{inv.terms_days === 0 ? "Due on receipt" : `Net ${inv.terms_days}`}</dd>
                {inv.customer_po && <><dt className="text-muted">{inv.po_label}</dt><dd>{inv.customer_po}</dd></>}
                <dt className="text-muted">Sent</dt><dd>{inv.sent_at ? `${formatDateTime(inv.sent_at, timezone)} to ${inv.sent_to.join(", ")}` : inv.status === "issued" ? <span className="font-semibold">Not sent yet</span> : "Not sent"}</dd>
              </dl>
              <p className="text-xs text-muted">From {sender.name}, with your company&apos;s logo and colour on the PDF.</p>
            </CardBody>
          </Card>

          {manage && inv.status === "draft" && (
            <Card>
              <CardHeader title="Issue this invoice" description="Issuing locks it, gives it the next invoice number and sets the due date. It cannot be edited afterwards; a mistake is voided and invoiced again." />
              <CardBody>
                <IssueInvoiceForm invoiceId={inv.id} today={today} action={issueInvoice} />
              </CardBody>
            </Card>
          )}

          {manage && inv.status === "issued" && (
            <Card>
              <CardHeader title="Email to the customer" description="Sends the PDF from your company's email setup. Demo companies and servers without email set up only preview." />
              <CardBody>
                <form action={sendInvoice} className="space-y-3">
                  <input type="hidden" name="invoice" value={inv.id} />
                  <Field label="To" htmlFor="to" hint="Separate addresses with commas"><Input id="to" name="to" defaultValue={b.email ?? ""} required /></Field>
                  <Field label="Subject" htmlFor="subject"><Input id="subject" name="subject" defaultValue={email.subject} maxLength={200} required /></Field>
                  <Field label="Message" htmlFor="message"><Textarea id="message" name="message" rows={6} defaultValue={email.message} maxLength={5000} required /></Field>
                  <SubmitButton pendingLabel="Sending…">{inv.sent_at ? "Send again" : "Send invoice"}</SubmitButton>
                </form>
              </CardBody>
            </Card>
          )}

          {manage && inv.status === "issued" && owed > 0 && (
            <Card>
              <CardHeader title="Record a payment" description={`Still owed: ${formatCents(owed)}. A payment can never be more than that.`} />
              <CardBody>
                <form action={addPayment} className="space-y-3" aria-label="Record a payment">
                  <input type="hidden" name="invoice" value={inv.id} />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Amount ($)" htmlFor="amount"><Input id="amount" name="amount" inputMode="decimal" defaultValue={(owed / 100).toFixed(2)} required /></Field>
                    <Field label="Received" htmlFor="received_on"><DateInput id="received_on" name="received_on" defaultValue={today} max={today} /></Field>
                  </div>
                  <Field label="Method" htmlFor="method">
                    <Select id="method" name="method" defaultValue="check">
                      {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </Field>
                  <Field label="Check or reference number" htmlFor="reference"><Input id="reference" name="reference" maxLength={80} /></Field>
                  <Field label="Note" htmlFor="note"><Input id="note" name="note" maxLength={300} /></Field>
                  <SubmitButton pendingLabel="Recording…">Record payment</SubmitButton>
                </form>
              </CardBody>
            </Card>
          )}

          {manage && inv.status !== "void" && paid === 0 && (
            <Card>
              <CardHeader title={inv.status === "draft" ? "Discard this draft" : "Void this invoice"} description={inv.status === "draft" ? `The ${orders.length > 1 ? "orders" : "order"} can be invoiced again.` : `It stays on record with its number and your reason; the ${orders.length > 1 ? "orders" : "order"} can then be invoiced again.`} />
              <CardBody>
                <form action={voidInvoice} className="space-y-3">
                  <input type="hidden" name="invoice" value={inv.id} />
                  <Field label="Reason" htmlFor="void_reason"><Input id="void_reason" name="reason" maxLength={300} required /></Field>
                  <SubmitButton variant="danger" pendingLabel="Voiding…">{inv.status === "draft" ? "Discard draft" : "Void invoice"}</SubmitButton>
                </form>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
