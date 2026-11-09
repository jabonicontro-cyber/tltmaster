"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { applyTicketCredit, recordTicketPayment, voidTicketPayment } from "@/app/(app)/billing/payments/actions";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { PAYMENT_METHODS, parseAmountCents } from "@/lib/billing/invoices";
import { applicationsOf, matchTickets, parseTicketList, payableCents, ticketKey, ticketState, type BilledTicket } from "@/lib/billing/ticket-payments";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { centsToInput, formatCents } from "@/lib/money";
import { useFormAction } from "@/components/ui/use-form-action";

// Payments by delivery ticket (TP1): record money received and the tickets it pays (whole or part), or apply a
// payment's remaining credit. The database checks every ticket and amount again.

type Mode = { kind: "record"; customerId: string; today: string } | { kind: "apply"; paymentId: string; creditCents: number };

export function TicketPaymentForm({ mode, tickets }: { mode: Mode; tickets: BilledTicket[] }) {
  const router = useRouter();
  const open = useMemo(() => tickets.filter((t) => payableCents(t) > 0), [tickets]);
  const [amount, setAmount] = useState(mode.kind === "apply" ? centsToInput(mode.creditCents) : "");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [pasted, setPasted] = useState("");
  const [notFound, setNotFound] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  const paymentCents = mode.kind === "apply" ? mode.creditCents : parseAmountCents(amount) ?? 0;
  const cents = (key: string) => parseAmountCents(selected[key] ?? "") ?? 0;
  const appliedCents = open.reduce((t, k) => t + cents(ticketKey(k)), 0);
  const leftCents = paymentCents - appliedCents;
  const overTicket = open.find((t) => cents(ticketKey(t)) > payableCents(t));
  const badAmount = Object.values(selected).some((v) => v.trim() !== "" && parseAmountCents(v) === null);
  const apps = applicationsOf(Object.fromEntries(open.map((t) => [ticketKey(t), cents(ticketKey(t))])), open);

  const { pending, onSubmit, formError, fieldError } = useFormAction<unknown>(
    (fd) => (mode.kind === "record" ? recordTicketPayment(fd) : applyTicketCredit(fd)),
    {
      onSuccess: (res) => {
        toast.success(res.message ?? "Saved.");
        setSelected({}); setPasted(""); setNotFound([]);
        if (mode.kind === "record") setAmount("");
        router.replace(mode.kind === "apply" ? window.location.pathname + window.location.search.replace(/[?&]apply=[^&]*/, "") : window.location.pathname + window.location.search, { scroll: false });
        router.refresh();
      },
    },
  );

  function toggle(t: BilledTicket, on: boolean) {
    setSelected((s) => {
      const next = { ...s };
      if (on) next[ticketKey(t)] = centsToInput(payableCents(t));
      else delete next[ticketKey(t)];
      return next;
    });
  }

  function findPasted() {
    const { matched, notFound: missing } = matchTickets(parseTicketList(pasted), open);
    setSelected((s) => {
      const next = { ...s };
      for (const t of matched) next[ticketKey(t)] = next[ticketKey(t)] ?? centsToInput(payableCents(t));
      return next;
    });
    setNotFound(missing);
    if (matched.length === 0 && missing.length === 0) toast.message("Type or paste the ticket numbers first.");
  }

  // Oldest tickets first until the money runs out; the last one may be part paid.
  function fillOldestFirst() {
    let left = paymentCents;
    const next: Record<string, string> = {};
    for (const t of open) {
      if (left <= 0) break;
      const take = Math.min(left, payableCents(t));
      next[ticketKey(t)] = centsToInput(take);
      left -= take;
    }
    setSelected(next);
  }

  const shown = filter.trim()
    ? open.filter((t) => [t.ticket_number, t.order_number, t.reference, t.invoice_number ?? "", ...t.qbo_numbers].some((v) => v.toUpperCase().includes(filter.trim().toUpperCase())))
    : open;
  const blocked = pending || appliedCents > paymentCents || !!overTicket || badAmount || (mode.kind === "apply" && apps.length === 0) || paymentCents <= 0;

  return (
    <form onSubmit={onSubmit} className="space-y-5" aria-label={mode.kind === "record" ? "Record a payment by ticket" : "Apply credit to tickets"}>
      {mode.kind === "record" ? (
        <>
          <input type="hidden" name="customer" value={mode.customerId} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Amount received" htmlFor="tp-amount" required error={fieldError("amount")}>
              <Input id="tp-amount" name="amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </Field>
            <Field label="Received on" htmlFor="tp-date" required error={fieldError("received_on")}>
              <DateInput id="tp-date" name="received_on" defaultValue={mode.today} max={mode.today} required />
            </Field>
            <Field label="How it was paid" htmlFor="tp-method">
              <Select id="tp-method" name="method" defaultValue="check">
                {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Check or bank reference" htmlFor="tp-ref"><Input id="tp-ref" name="reference" maxLength={80} /></Field>
          </div>
          <Field label="Note" htmlFor="tp-note"><Input id="tp-note" name="note" maxLength={300} /></Field>
        </>
      ) : (
        <input type="hidden" name="payment" value={mode.paymentId} />
      )}
      <input type="hidden" name="tickets" value={JSON.stringify(apps)} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <Field label="Ticket numbers from the check stub or remittance" htmlFor="tp-paste" hint="Paste or type them, separated by commas, spaces or new lines. Scale ticket numbers work too.">
          <Textarea id="tp-paste" rows={2} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="TKT-1017, TKT-1018, 1019" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={findPasted}>Select these tickets</Button>
          <Button variant="ghost" size="sm" onClick={fillOldestFirst} disabled={paymentCents <= 0}>Oldest first</Button>
        </div>
      </div>
      {notFound.length > 0 && (
        <p className="text-sm text-amber-800" role="status">
          Not found among this customer&apos;s open tickets: {notFound.join(", ")}. Check the number, or it may already be paid.
        </p>
      )}

      {open.length === 0 ? (
        <p className="text-sm text-muted">This customer has no open billed tickets.{mode.kind === "record" ? " A payment recorded now is kept as credit." : ""}</p>
      ) : (
        <div className="space-y-2">
          {open.length > 8 && (
            <div className="max-w-xs">
              <label className="sr-only" htmlFor="tp-filter">Filter tickets</label>
              <Input id="tp-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by ticket, order or invoice" className="h-9 text-sm" />
            </div>
          )}
          <TableWrap className="max-h-[28rem] overflow-y-auto">
            <Table>
              <thead>
                <tr>
                  <Th className="w-10"><span className="sr-only">Pay</span></Th>
                  <Th>Ticket</Th>
                  <Th>Delivered</Th>
                  <Th>Order</Th>
                  <Th>Invoice</Th>
                  <Th align="right">Open</Th>
                  <Th align="right" className="w-36">Pay now</Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => {
                  const key = ticketKey(t);
                  const on = key in selected;
                  const over = cents(key) > payableCents(t);
                  return (
                    <Tr key={key} className={cn(on && "bg-surface")}>
                      <Td>
                        <input type="checkbox" className="size-4 accent-[var(--color-strong)]" aria-label={`Pay ticket ${t.ticket_number}`} checked={on} onChange={(e) => toggle(t, e.target.checked)} />
                      </Td>
                      <Td className="font-medium">
                        {t.ticket_number}
                        {t.reference && <span className="block text-xs font-normal text-muted">Scale {t.reference}</span>}
                      </Td>
                      <Td className="text-muted">{t.delivered_at ? formatDate(t.delivered_at.slice(0, 10)) : "–"}</Td>
                      <Td className="text-muted">{t.order_number}</Td>
                      <Td className="text-muted">{t.invoice_number ?? (t.qbo_numbers.length ? `QuickBooks ${t.qbo_numbers.join(", ")}` : "–")}</Td>
                      <Td align="right" className="tabular-nums">
                        {formatCents(payableCents(t))}
                        {(ticketState(t) === "part" || payableCents(t) < t.open_cents) && <span className="block text-xs text-muted">of {formatCents(t.billed_cents)}</span>}
                      </Td>
                      <Td align="right">
                        <label className="sr-only" htmlFor={`tp-${key}`}>Amount for ticket {t.ticket_number}</label>
                        <Input
                          id={`tp-${key}`} inputMode="decimal" placeholder="0.00" value={selected[key] ?? ""}
                          onChange={(e) => setSelected((s) => ({ ...s, [key]: e.target.value }))}
                          className={cn("h-9 text-right tabular-nums", over && "border-critical")}
                          aria-invalid={over || undefined}
                        />
                        {over && <span className="mt-1 block text-xs text-critical">More than is open</span>}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm" aria-live="polite">
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          <div className="flex gap-1.5"><dt className="text-muted">{mode.kind === "apply" ? "Credit" : "Payment"}</dt><dd className="font-medium tabular-nums">{formatCents(paymentCents)}</dd></div>
          <div className="flex gap-1.5"><dt className="text-muted">On {apps.length} {apps.length === 1 ? "ticket" : "tickets"}</dt><dd className="font-medium tabular-nums">{formatCents(appliedCents)}</dd></div>
          <div className="flex gap-1.5">
            <dt className="text-muted">{leftCents < 0 ? "Over by" : mode.kind === "apply" ? "Credit left" : "Kept as credit"}</dt>
            <dd className={cn("font-medium tabular-nums", leftCents < 0 && "text-critical")}>{formatCents(Math.abs(leftCents))}</dd>
          </div>
        </dl>
        <Button type="submit" loading={pending} disabled={blocked}>
          {mode.kind === "record" ? (pending ? "Recording…" : "Record payment") : (pending ? "Applying…" : "Apply credit")}
        </Button>
      </div>
      <FormError message={formError} />
    </form>
  );
}

export function VoidTicketPayment({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [openForm, setOpenForm] = useState(false);
  const { pending, onSubmit, formError } = useFormAction(voidTicketPayment, {
    onSuccess: (res) => { toast.success(res.message ?? "Voided."); setOpenForm(false); router.refresh(); },
  });
  if (!openForm) return <Button variant="ghost" size="sm" onClick={() => setOpenForm(true)}>Void</Button>;
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="payment" value={paymentId} />
      <label className="sr-only" htmlFor={`tv-${paymentId}`}>Reason to void this payment</label>
      <Input id={`tv-${paymentId}`} name="reason" placeholder="Reason, like check bounced" maxLength={300} className="h-8 w-56 text-sm" required autoFocus />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>Void payment</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpenForm(false)}>Cancel</Button>
      <FormError message={formError} />
    </form>
  );
}
