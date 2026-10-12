"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { cancelTimeOff, decideTimeOff } from "@/app/(app)/time-off/actions";

export function TimeOffActions({ id, canDecide, canCancel }: { id: string; canDecide: boolean; canCancel: boolean }) {
  const router = useRouter();
  const [action, setAction] = useState<"approved" | "denied" | "cancel" | null>(null);
  const [note, setNote] = useState("");
  if (!canDecide && !canCancel) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {canDecide && <Button onClick={() => { setNote(""); setAction("approved"); }}>Approve</Button>}
      {canDecide && <Button variant="secondary" onClick={() => { setNote(""); setAction("denied"); }}>Deny</Button>}
      {canCancel && <Button variant="ghost" onClick={() => { setNote(""); setAction("cancel"); }}>Cancel request</Button>}
      <ConfirmDialog
        open={Boolean(action)}
        onOpenChange={(o) => !o && setAction(null)}
        title={action === "approved" ? "Approve time off" : action === "denied" ? "Deny time off" : "Cancel this request"}
        description={action === "approved"
          ? "Approved leave blocks the driver for overlapping loads. Existing assignments are not canceled — you will see which ones need review."
          : action === "denied" ? "The employee sees the decision and your note." : "The dates become free again."}
        confirmLabel={action === "approved" ? "Approve" : action === "denied" ? "Deny" : "Cancel request"}
        tone={action === "approved" ? "primary" : "danger"}
        onConfirm={async () => {
          if (!action) return;
          const r = action === "cancel" ? await cancelTimeOff({ id, note }) : await decideTimeOff({ id, decision: action, note });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved.");
          router.refresh();
        }}
      >
        <Field label="Note (optional)" htmlFor="to-note">
          <Textarea id="to-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
