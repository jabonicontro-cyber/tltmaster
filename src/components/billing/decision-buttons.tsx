"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCheck, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { acknowledgeExceptions, revertHandoff } from "@/app/(app)/billing/actions";

/** Acknowledge exactly the exceptions shown (identified by their fingerprint). */
export function AcknowledgeButton({ orderId, orderNumber, fingerprint, count, size = "md" }: { orderId: string; orderNumber: string; fingerprint: string; count: number; size?: "sm" | "md" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button size={size} variant="secondary" icon={<CheckCheck className="size-4" />} onClick={() => { setReason(""); setOpen(true); }}>
        Acknowledge
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Acknowledge ${count} exception${count === 1 ? "" : "s"} on ${orderNumber}`}
        description="Records that you reviewed these differences and the order can be billed as it stands. Tickets and prices are not changed. If the tickets change later, a new acknowledgment is needed."
        confirmLabel="Acknowledge"
        onConfirm={async () => {
          const r = await acknowledgeExceptions({ orderId, fingerprint, reason });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      >
        <Field label="Reason" htmlFor={`ack-${orderId}`} required hint="Kept in the order's billing history, e.g. “Customer agreed to bill delivered tons.”">
          <Textarea id={`ack-${orderId}`} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}

export function RevertHandoffButton({ handoffOrderId, orderId, orderNumber, batchNumber }: { handoffOrderId: string; orderId: string; orderNumber: string; batchNumber: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => { setReason(""); setOpen(true); }}>
        Undo handoff
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Undo handoff of ${orderNumber}`}
        description={`Takes the order out of batch ${batchNumber} and back into billing review. If it was already invoiced in your accounting system, fix that there too. The handoff stays on record as undone.`}
        confirmLabel="Undo handoff"
        tone="danger"
        onConfirm={async () => {
          const r = await revertHandoff({ handoffOrderId, orderId, reason });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      >
        <Field label="Reason" htmlFor={`undo-${handoffOrderId}`} required hint="Kept in the order's billing history.">
          <Textarea id={`undo-${handoffOrderId}`} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
