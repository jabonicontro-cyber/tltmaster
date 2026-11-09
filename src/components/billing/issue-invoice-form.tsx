"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";

/**
 * Issue a draft invoice, with a confirmation step first (first-day office walkthrough 2026-11-09): issuing numbers and
 * locks the invoice and cannot be undone, so the button only asks; "Yes, issue it" submits. A plain form: the server
 * action checks the permission and the invoice's state again.
 */
export function IssueInvoiceForm({ invoiceId, today, action }: { invoiceId: string; today: string; action: (formData: FormData) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="invoice" value={invoiceId} />
      <Field label="Issue date" htmlFor="issue_date"><DateInput id="issue_date" name="issue_date" defaultValue={today} max={today} /></Field>
      {confirming ? (
        <div role="alertdialog" aria-labelledby="issue-confirm-title" aria-describedby="issue-confirm-text" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <p id="issue-confirm-title" className="font-semibold">Issue this invoice now?</p>
          <p id="issue-confirm-text">It gets the next invoice number and is locked. This cannot be undone: a mistake afterwards is voided and invoiced again. Nothing is emailed until you send it.</p>
          <div className="flex flex-wrap gap-2">
            <SubmitButton pendingLabel="Issuing…">Yes, issue it</SubmitButton>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setConfirming(true)}>Issue invoice</Button>
      )}
    </form>
  );
}
