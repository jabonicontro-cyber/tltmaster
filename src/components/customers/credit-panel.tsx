"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
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
export function CreditPanel({ customerId, hold, limitCents, canManage }: { customerId: string; hold: CreditView | null; limitCents: number | null; canManage: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [reason, setReason] = useState("");
  const [holding, setHolding] = useState(false);
  const [limit, setLimit] = useState(limitCents === null ? "" : (limitCents / 100).toFixed(2));
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => start(async () => {
    const r = await fn();
    if (!r.ok) return void toast.error(r.error ?? "Not saved.");
    toast.success(r.message ?? "Saved.");
    setHolding(false);
    setReason("");
    router.refresh();
  });
  const manual = hold?.reasons.includes("manual") ?? false;
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2">Credit{hold ? <Badge tone="red">On credit hold</Badge> : <Badge tone="green">In good standing</Badge>}</span>}
        description="Orders and dispatch for a customer on hold are not blocked; whoever goes ahead records why."
      />
      <CardBody className="space-y-4">
        {hold && (
          <ul className="space-y-1 text-sm" aria-label="Why this customer is on hold">
            {hold.reasons.map((r) => (
              <li key={r}>
                <span className="font-semibold text-ink">{REASON[r]}</span>
                {r === "manual" && hold.note ? <span className="text-muted"> — {hold.note}</span> : null}
                {r === "overdue" && hold.oldestOverdueDays !== null ? <span className="text-muted"> — oldest {hold.oldestOverdueDays} days past due</span> : null}
                {r === "over_limit" && hold.openCents !== null && hold.creditLimitCents !== null ? <span className="text-muted"> — {formatCents(hold.openCents)} open of {formatCents(hold.creditLimitCents)}</span> : null}
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
