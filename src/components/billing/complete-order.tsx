"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { ORDER_STATUS_LABELS, orderTransitionLabel } from "@/lib/orders/status";
import type { OrderStatus } from "@/server/data/types";
import { setOrderStatus } from "@/app/(app)/orders/actions";

/**
 * Complete the order from its billing page (first-day office walkthrough 2026-11-09), through the same order status
 * action as the order page: each step is checked again by the database (permission, current status, edit counter).
 * A scheduled or dispatched order is started first, then completed; nothing is skipped.
 */
export function CompleteOrderButton({ orderId, orderNumber, status, editSeq, steps, facts }: {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  editSeq: number;
  /** From completionSteps(status): e.g. ["in_progress", "completed"]. */
  steps: OrderStatus[];
  /** Plain facts to read before completing (loads without a ticket, tickets not accepted, loads still to run). */
  facts: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (steps.length === 0) return null;
  const twoSteps = steps.length > 1;
  return (
    <>
      <Button size="sm" icon={<CheckCircle2 className="size-4" />} onClick={() => { setNote(""); setOpen(true); }}>
        {twoSteps ? "Start work and complete" : "Mark completed"}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Complete ${orderNumber}`}
        description={twoSteps
          ? `The order is ${ORDER_STATUS_LABELS[status].toLowerCase()}. An order is started before it is completed, so this records ${steps.map((s, i) => (i === 0 ? orderTransitionLabel(status, s) : orderTransitionLabel(steps[i - 1], s))).join(", then ")}. Completed orders are final and can no longer be edited; history is kept.`
          : "Completed orders are final and can no longer be edited; history is kept."}
        confirmLabel={twoSteps ? "Start work and complete" : "Mark completed"}
        onConfirm={async () => {
          let from = status;
          let seq = editSeq;
          for (const to of steps) {
            const r = await setOrderStatus({ orderId, from, status: to, note: to === "completed" ? note : "", expectedEditSeq: seq });
            if (!r.ok) {
              if (from !== status) router.refresh();
              return from !== status ? `The order is now ${ORDER_STATUS_LABELS[from].toLowerCase()}, but it could not be completed: ${r.error}` : r.error;
            }
            from = r.data.status;
            seq = r.data.editSeq;
          }
          toast.success(`${orderNumber} marked completed.`);
          router.refresh();
        }}
      >
        {facts.length > 0 && (
          <div role="note" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <p className="font-semibold">Before you complete it:</p>
            <ul className="list-disc pl-5">{facts.map((f) => <li key={f}>{f}</li>)}</ul>
            <p className="mt-1">You can still complete it (paper tickets often arrive later); billing waits until every load has an accepted ticket.</p>
          </div>
        )}
        <Field label="Note (optional)" htmlFor="complete-note" hint="Shown in the order history.">
          <Input id="complete-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
