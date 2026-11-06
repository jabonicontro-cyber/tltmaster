"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { applyDetention, dismissDetention } from "@/app/(app)/billing/actions";

export interface DetentionRow {
  stop_time_id: string;
  load_number: number;
  load_date: string;
  place: string;
  wait_minutes: number;
  free_minutes: number;
  billable_minutes: number;
  hours: string | number;
  rate_cents: number;
  amount_cents: string | number;
  status: "applied" | "dismissed" | null;
  reason: string;
}

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`);

/** Detention proposals for one order (DT1): computed from recorded waits; a person adds or dismisses each one. */
export function DetentionCard({ orderId, rows, canManage, locked }: { orderId: string; rows: DetentionRow[]; canManage: boolean; locked: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => start(async () => {
    const r = await fn();
    if (!r.ok) return void toast.error(r.error ?? "Not saved.");
    toast.success(r.message ?? "Saved.");
    setDismissing(null);
    setReason("");
    router.refresh();
  });
  const open = rows.filter((r) => !r.status).length;
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-2">Detention{open > 0 && <Badge tone="amber">{open} to review</Badge>}</span>}
        description="Waits past the customer's free time, from the Arrived and Left times. Nothing is billed until someone adds it."
      />
      <ul className="divide-y divide-line" aria-label="Detention proposals">
        {rows.map((r) => (
          <li key={r.stop_time_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 sm:px-6">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{r.place} · load {r.load_number}, {formatDate(r.load_date)}</p>
              <p className="text-sm text-muted">
                Waited {minutes(r.wait_minutes)}, {r.free_minutes} min free: {Number(r.hours).toFixed(2)} h × {formatCents(r.rate_cents)} = <span className="font-semibold text-ink tabular">{formatCents(Number(r.amount_cents))}</span>
              </p>
              {r.status === "dismissed" && <p className="text-sm text-muted">Not billed: {r.reason}</p>}
            </div>
            {r.status === "applied" ? <Badge tone="green">Added to the order</Badge>
              : r.status === "dismissed" ? <Badge tone="gray">Not billed</Badge>
              : canManage && !locked ? (
                dismissing === r.stop_time_id ? (
                  <form className="flex w-full flex-wrap gap-2 sm:w-auto" onSubmit={(e) => { e.preventDefault(); run(() => dismissDetention({ stopTimeId: r.stop_time_id, orderId, reason })); }}>
                    <Input aria-label="Why it is not billed" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Why it is not billed" className="w-64" autoFocus />
                    <Button type="submit" size="sm" variant="secondary" disabled={busy || !reason.trim()}>Record</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDismissing(null)}>Cancel</Button>
                  </form>
                ) : (
                  <span className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => run(() => applyDetention({ stopTimeId: r.stop_time_id, orderId }))}>Add to order</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDismissing(r.stop_time_id)}>Don&apos;t bill</Button>
                  </span>
                )
              ) : <Badge tone="amber">To review</Badge>}
          </li>
        ))}
      </ul>
      {locked && open > 0 && <p className="px-5 pb-4 text-sm text-muted sm:px-6">This order was handed off for billing. Undo the handoff to add detention.</p>}
    </Card>
  );
}
