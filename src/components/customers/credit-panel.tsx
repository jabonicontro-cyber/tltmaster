"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { useRefresh } from "@/components/ui/use-refresh";
import { formatCents } from "@/lib/money";
import { setCustomerCreditHold, setCustomerCreditLimit } from "@/app/(app)/customers/actions";

export interface CreditView {
  reasons: Array<"manual" | "overdue" | "over_limit">;
  note: string;
  openCents: number | null;
  creditLimitCents: number | null;
  oldestOverdueDays: number | null;
}

const REASON = { manual: "Put on hold by billing", overdue: "Invoices past due", over_limit: "Over the credit limit" } as const;

/**
 * Credit hold (B128): billing puts a customer on hold with a reason, releases it, and sets a credit limit. Orders and
 * dispatch for a customer on hold are never blocked; the person going ahead records why.
 */
export function CreditPanel({ customerId, hold, limitCents, overdueCents = null, canManage }: {
  customerId: string;
  hold: CreditView | null;
  limitCents: number | null;
  /** Past due on issued invoices (people who see billing); null when not known. Shown beside the badge (M7). */
  overdueCents?: number | null;
  canManage: boolean;
}) {
  const { refresh, refreshing } = useRefresh();
  const [saving, start] = useTransition();
  // Busy until the badge and reasons above show the change, not only until the server said yes (M3).
  const busy = saving || refreshing;
  const [reason, setReason] = useState("");
  const [holding, setHolding] = useState(false);
  const [limit, setLimit] = useState(limitCents === null ? "" : (limitCents / 100).toFixed(2));
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => start(async () => {
    const r = await fn();
    if (!r.ok) return void toast.error(r.error ?? "Not saved.");
    setHolding(false);
    setReason("");
    // Not awaited inside the transition (React would hold the refresh until it ends); the toast comes with the new state.
    void refresh().then(() => toast.success(r.message ?? "Saved."));
  });
  const manual = hold?.reasons.includes("manual") ?? false;
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            Credit
            {hold ? <Badge tone="red">On credit hold</Badge> : overdueCents ? <Badge tone="amber">Not on hold</Badge> : <Badge tone="green">In good standing</Badge>}
            {overdueCents ? <span className="text-sm font-semibold text-amber-700 tabular" data-testid="credit-overdue">{formatCents(overdueCents)} overdue</span> : null}
          </span>
        }
        description="While on hold, a new order needs someone who can change orders, and each load dispatched needs a reason. Both reasons are recorded. Billing releases the hold."
      />
      <CardBody className="space-y-4">
        {!hold && overdueCents ? (
          <p className="text-sm text-muted">
            Invoices are past due, but the customer is not on hold: that happens on its own only when Settings → Invoicing sets how many days past due put a customer on hold.{canManage ? " You can also put it on hold here." : ""}
          </p>
        ) : null}
        {hold && (
          <ul className="space-y-1 text-sm" aria-label="Why this customer is on hold">
            {hold.reasons.map((r) => (
              <li key={r}>
                <span className="font-semibold text-ink">{REASON[r]}</span>
                {r === "manual" && hold.note ? <span className="text-muted">, {hold.note}</span> : null}
                {r === "overdue" && hold.oldestOverdueDays !== null ? <span className="text-muted">, oldest {hold.oldestOverdueDays} days past due</span> : null}
                {r === "over_limit" && hold.openCents !== null && hold.creditLimitCents !== null ? <span className="text-muted">, {formatCents(hold.openCents)} open of {formatCents(hold.creditLimitCents)}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="flex flex-wrap items-end gap-3">
            {manual ? (
              <Button variant="secondary" loading={busy} onClick={() => run(() => setCustomerCreditHold(customerId, false, ""))}>Release hold</Button>
            ) : holding ? (
              <>
                <Field label="Why is the customer on hold?" htmlFor="credit-hold-reason" required className="min-w-64 flex-1">
                  <Input id="credit-hold-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Two invoices 60 days late" />
                </Field>
                <Button loading={busy} disabled={reason.trim().length < 3} onClick={() => run(() => setCustomerCreditHold(customerId, true, reason))}>Put on hold</Button>
                <Button variant="ghost" onClick={() => setHolding(false)}>Cancel</Button>
              </>
            ) : (
              <Button variant="secondary" onClick={() => setHolding(true)}>Put on credit hold…</Button>
            )}
          </div>
        )}
        {canManage ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <Field label="Credit limit ($)" htmlFor="credit-limit" hint="Empty: no limit. Open issued invoices above it put the customer on hold.">
              <Input id="credit-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} className="max-w-40" />
            </Field>
            <Button variant="secondary" loading={busy} onClick={() => run(() => setCustomerCreditLimit(customerId, limit))}>Save limit</Button>
          </div>
        ) : limitCents !== null ? (
          <p className="text-sm text-muted">Credit limit {formatCents(limitCents)}</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
