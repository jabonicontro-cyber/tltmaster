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

/**
 * Open urgent flags in this company, oldest first, so dispatch sees them before planning the day. Each card says which
 * truck and driver the order already has (walkthrough D7) and offers the next step in place: Acknowledge, then
 * "Mark truck assigned" once a truck is on the board. Resolving (which needs a note) stays on the order.
 */
export function UrgentOrders({ items, canAcknowledge, timezone, back, now, assignments = {} }: {
  items: OpenUrgency[]; canAcknowledge: boolean; timezone: string; back: string; now: string;
  /** Order id -> its active assignments in words ("Truck 101 · Daniel Ruiz (load 1, Nov 15, 8:00 AM)"). */
  assignments?: Record<string, string[]>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <section aria-label="Urgent orders" className="urgent-edge mb-4 rounded-panel border bg-card">
      <h2 className="flex items-center gap-2 border-b border-line/70 px-5 py-3 font-semibold text-ink sm:px-6">
        <Siren className="size-5 text-critical" aria-hidden /> Urgent orders ({items.length})
      </h2>
      <ul className="divide-y divide-line">
        {items.map((u) => {
          const late = u.needed_by && new Date(u.needed_by).getTime() < new Date(now).getTime();
          return (
            <li key={u.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3.5 sm:px-6">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Link href={withReturn(`/orders/${u.order_id}`, back)} className="font-bold tabular hover:underline">{u.orders?.order_number ?? "Order"}</Link>
                  <span className="text-sm text-muted">{u.orders?.customers?.name}</span>
                  <Badge tone={u.state === "awaiting_acknowledgement" ? "red" : u.state === "assigned" ? "green" : "amber"}>{URGENCY_LABELS[u.state]}</Badge>
                  {u.needed_by && <Badge tone={late ? "red" : "gray"}>{late ? "Past needed-by " : "Needed by "}{formatDateTime(u.needed_by, timezone)}</Badge>}
                </p>
                <p className="text-sm">{u.reason}</p>
                <p className="text-sm text-ink">
                  {assignments[u.order_id]?.length
                    ? <>On the board: {assignments[u.order_id].join("; ")}</>
                    : <span className="text-muted">No truck assigned yet{u.orders?.scheduled_start ? "" : ": schedule the order first"}.</span>}
                </p>
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
                    else { toast.success(`${u.orders?.order_number ?? "Order"} acknowledged. You are shown as handling it; mark the truck assigned or resolve it from the order.`); router.refresh(); }
                  }}
                >
                  Acknowledge
                </Button>
              )}
              {/* After acknowledging: "Mark truck assigned" here once the order has a truck on the board (D7); resolving
                  needs a note, so it stays on the order's urgency panel, offered as a plain link. */}
              {canAcknowledge && u.state !== "awaiting_acknowledgement" && (
                <div className="flex flex-col items-end gap-1.5">
                  {u.state !== "assigned" && assignments[u.order_id]?.length ? (
                    <Button
                      size="sm"
                      loading={busy === u.id}
                      onClick={async () => {
                        setBusy(u.id);
                        const r = await updateOrderUrgency({ urgencyId: u.id, orderId: u.order_id, state: "assigned", note: "" });
                        setBusy(null);
                        if (!r.ok) toast.error(r.error);
                        else { toast.success(`${u.orders?.order_number ?? "Order"}: truck assigned. Resolve it once the delivery is done or confirmed.`); router.refresh(); }
                      }}
                    >
                      Mark truck assigned
                    </Button>
                  ) : null}
                  <Link href={withReturn(`/orders/${u.order_id}`, back)} className="text-sm font-semibold text-brand-fg underline">
                    {u.state === "assigned" ? "Resolve it on the order" : "Other steps on the order"}
                  </Link>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
