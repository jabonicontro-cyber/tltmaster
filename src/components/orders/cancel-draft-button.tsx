"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { orderReasonMissing } from "@/lib/orders/status";
import { setOrderStatus } from "@/app/(app)/orders/actions";

/**
 * "Cancel order" on a draft's edit page (walkthrough 2026-11-11: a draft entered by mistake had no way out from here).
 * The same status change as on the order's page: a reason is required, the database checks the permission (orders.edit,
 * or orders.create for one's own direct draft) and records it in the order's history. Then back to the order.
 */
export function CancelDraftButton({ orderId, orderNumber, editSeq }: { orderId: string; orderNumber: string; editSeq: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  return (
    <>
      <Button variant="ghost" className="text-red-700 hover:bg-red-50" icon={<XCircle className="size-4" />} onClick={() => { setNote(""); setOpen(true); }}>
        Cancel order
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Cancel order · ${orderNumber}`}
        description="Canceled orders are final and cannot be reopened. History is kept. Unsaved changes on this page are not kept."
        confirmLabel="Cancel order"
        cancelLabel="Keep order"
        tone="danger"
        onConfirm={async () => {
          const missing = orderReasonMissing("canceled", note);
          if (missing) return missing;
          const r = await setOrderStatus({ orderId, from: "draft", status: "canceled", note, expectedEditSeq: editSeq });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Order canceled.");
          router.push(`/orders/${orderId}`);
        }}
      >
        <Field label="Reason" htmlFor="cancel-draft-note" required hint="Shown in the order history.">
          <Input id="cancel-draft-note" value={note} maxLength={1000} placeholder="e.g. Entered by mistake" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
