"use client";

import { DateInput } from "@/components/ui/date-input";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { PAYMENT_METHODS } from "@/lib/billing/invoices";

/**
 * Record a payment on an issued invoice (walkthrough M2, owner and office). A refused payment keeps everything typed,
 * above all the check number, and says why next to the field it is about (an amount over what is still owed shows
 * under Amount), instead of reloading the page with the message at the top and an empty form. The server action and
 * the database decide everything: permission, the invoice's state and the amount still owed.
 */
export function InvoicePaymentForm({ invoiceId, owedCents, today, action }: {
  invoiceId: string;
  owedCents: number;
  today: string;
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(action);
  const amountError = fieldError("amount");
  const dateError = fieldError("received_on");
  const methodError = fieldError("method");
  // A refusal that is not about one field (no permission, the invoice changed) is shown above the button.
  const generalError = formError && !amountError && !dateError && !methodError ? formError : null;
  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="Record a payment" noValidate>
      <input type="hidden" name="invoice" value={invoiceId} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount ($)" htmlFor="amount" error={amountError}>
          <Input id="amount" name="amount" inputMode="decimal" defaultValue={(owedCents / 100).toFixed(2)} required {...describedBy("amount", amountError)} />
        </Field>
        <Field label="Received" htmlFor="received_on" error={dateError}>
          <DateInput id="received_on" name="received_on" defaultValue={today} max={today} {...describedBy("received_on", dateError)} />
        </Field>
      </div>
      <Field label="Method" htmlFor="method" error={methodError}>
        <Select id="method" name="method" defaultValue="check" {...describedBy("method", methodError)}>
          {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <Field label="Check or reference number" htmlFor="reference"><Input id="reference" name="reference" maxLength={80} /></Field>
      <Field label="Note" htmlFor="note"><Input id="note" name="note" maxLength={300} /></Field>
      <FormError message={generalError} />
      <Button type="submit" loading={pending}>{pending ? "Recording…" : "Record payment"}</Button>
    </form>
  );
}
