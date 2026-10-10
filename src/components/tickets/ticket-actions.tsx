"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, Flag, Pencil, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import type { TicketStatus } from "@/lib/tickets/rules";
import { reviewTicket } from "@/app/(app)/tickets/actions";

interface Props {
  ticketId: string;
  ticketNumber: string;
  orderId: string;
  status: TicketStatus;
  permissions: { edit: boolean; review: boolean };
  /** Opened from the review queue: after a decision, go to the next ticket (or back to the queue when it is empty). */
  queue?: { nextHref: string | null; doneHref: string } | null;
}

export function TicketActions({ ticketId, ticketNumber, orderId, status, permissions, queue }: Props) {
  const router = useRouter();
  const [action, setAction] = useState<"accept" | "flag" | "void" | null>(null);
  const [note, setNote] = useState("");
  const live = status !== "voided" && status !== "superseded";
  if (!live) return null;
  const canCorrect = status === "accepted" ? permissions.review : permissions.edit;

  return (
    <div className="flex flex-wrap gap-2">
      {permissions.review && status !== "accepted" && (
        <Button data-accept-ticket icon={<CheckCircle2 className="size-4" />} onClick={() => { setNote(""); setAction("accept"); }}>
          {queue?.nextHref ? "Accept and next" : "Accept"}
        </Button>
      )}
      {canCorrect && (
        <ButtonLink href={`/tickets/${ticketId}/correct`} variant="secondary" icon={<Pencil className="size-4" />}>
          Correct
        </ButtonLink>
      )}
      {permissions.review && status !== "needs_review" && (
        <Button variant="secondary" icon={<Flag className="size-4" />} onClick={() => { setNote(""); setAction("flag"); }}>
          Flag for review
        </Button>
      )}
      {permissions.review && (
        <Button variant="danger" icon={<XCircle className="size-4" />} onClick={() => { setNote(""); setAction("void"); }}>
          Void
        </Button>
      )}

      <ConfirmDialog
        open={Boolean(action)}
        onOpenChange={(o) => !o && setAction(null)}
        title={action === "accept" ? `Accept ticket ${ticketNumber}` : action === "flag" ? `Flag ticket ${ticketNumber} for review` : `Void ticket ${ticketNumber}`}
        description={
          action === "accept"
            ? "Confirms the ticket matches the paper record. It does not bill the customer or change the order."
            : action === "void"
              ? "The ticket stays on record as voided and no longer counts for the load. This cannot be undone — enter a new ticket if needed."
              : "Marks the ticket as needing office review."
        }
        confirmLabel={action === "accept" ? "Accept" : action === "flag" ? "Flag" : "Void ticket"}
        tone={action === "void" ? "danger" : "primary"}
        onConfirm={async () => {
          if (!action) return;
          const r = await reviewTicket({ ticketId, orderId, action, note });
          if (!r.ok) return r.error;
          if (queue) {
            toast.success(`${r.message ?? "Saved"}${queue.nextHref ? " Opening the next ticket." : " The review queue is done."}`);
            router.push(queue.nextHref ?? queue.doneHref);
          } else {
            toast.success(r.message ?? "Saved");
            router.refresh();
          }
        }}
      >
        <Field label={action === "accept" ? "Note (optional)" : "Reason"} htmlFor="review-note" required={action !== "accept"} hint="Kept in the ticket history.">
          <Input id="review-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
