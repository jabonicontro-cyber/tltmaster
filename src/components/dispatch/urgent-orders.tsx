"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Siren } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { updateOrderUrgency } from "@/app/(app)/orders/actions";
import { formatDate, formatDateTime } from "@/lib/dates";
import { URGENCY_LABELS, URGENCY_NEXT_OWNER } from "@/lib/orders/urgency";
import { withReturn } from "@/lib/safe-redirect";
import type { OpenUrgency } from "@/server/data/urgency";

/** Open urgent flags in this company, oldest first, so dispatch sees them before planning the day. */
export function UrgentOrders({ items, canAcknowledge, timezone, back, now }: { items: OpenUrgency[]; canAcknowledge: boolean; timezone: string; back: string; now: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <section aria-label="Urgent orders" className="mb-4 rounded-lg border-2 border-critical bg-card">
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-2 font-bold text-ink">
        <Siren className="size-5 text-critical" aria-hidden /> Urgent orders ({items.length})
      </h2>
      <ul className="divide-y divide-line">
        {items.map((u) => {
          const late = u.needed_by && new Date(u.needed_by).getTime() < new Date(now).getTime();
          return (
            <li key={u.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Link href={withReturn(`/orders/${u.order_id}`, back)} className="font-bold tabular hover:underline">{u.orders?.order_number ?? "Order"}</Link>
                  <span className="text-sm text-muted">{u.orders?.customers?.name}</span>
                  <Badge tone={u.state === "awaiting_acknowledgement" ? "red" : u.state === "assigned" ? "green" : "amber"}>{URGENCY_LABELS[u.state]}</Badge>
                  {u.needed_by && <Badge tone={late ? "red" : "gray"}>{late ? "Past needed-by " : "Needed by "}{formatDateTime(u.needed_by, timezone)}</Badge>}
                </p>
                <p className="text-sm">{u.reason}</p>
                <p className="text-xs text-muted">
                  Next: {URGENCY_NEXT_OWNER[u.state]}
                  {u.orders?.scheduled_start ? ` · scheduled from ${formatDate(u.orders.scheduled_start)}` : " · not scheduled yet"}
                </p>
              </div>
              {canAcknowledge && u.state === "awaiting_acknowledgement" && (
                <Button
                  size="sm"
                  loading={busy === u.id}
                  onClick={async () => {
                    setBusy(u.id);
                    const r = await updateOrderUrgency({ urgencyId: u.id, orderId: u.order_id, state: "acknowledged", note: "" });
                    setBusy(null);
                    if (!r.ok) toast.error(r.error);
                    else { toast.success("Acknowledged. You are shown as handling it."); router.refresh(); }
                  }}
                >
                  Acknowledge
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
