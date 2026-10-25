"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { formatDateTime } from "@/lib/dates";
import { closeWorkspace, reopenWorkspace, resyncWorkspace } from "@/app/(app)/communications/actions";

/** Scope, synchronization state and lifecycle of an operational workspace. */
export function WorkspacePanel(props: {
  conversationId: string;
  scope: string;
  status: "active" | "closed" | "archived";
  syncStatus: "ok" | "failed";
  syncError: string;
  lastSyncedAt: string | null;
  workFinishedAt: string | null;
  archiveHours: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(p: Promise<{ ok: boolean; error?: string; message?: string }>) {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (!r.ok) return toast.error(r.error ?? "Could not save.");
    toast.success(r.message ?? "Saved.");
    router.refresh();
  }

  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="text-xs font-semibold text-muted">Scope</p>
        <p className="text-ink">{props.scope}</p>
      </div>
      <div>
        <p className="text-xs font-semibold text-muted">Driver membership</p>
        {props.syncStatus === "failed" ? (
          <div role="alert" className="mt-1 space-y-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-900">
            <p><span className="font-semibold">Membership could not be updated after a dispatch change.</span> Posting is paused so nobody writes to the wrong people. Dispatch itself was not affected.</p>
            {props.syncError && <p className="text-xs">Reason: {props.syncError}</p>}
            {props.canManage && <Button size="sm" loading={busy} icon={<RefreshCw className="size-4" />} onClick={() => run(resyncWorkspace(props.conversationId))}>Resync now</Button>}
          </div>
        ) : (
          <p className="text-muted">
            Follows dispatch automatically{props.lastSyncedAt ? ` · last updated ${formatDateTime(props.lastSyncedAt)}` : ""}.
          </p>
        )}
      </div>
      {props.workFinishedAt && props.status === "active" && (
        <p className="text-muted">All loads are finished. The workspace archives automatically {props.archiveHours === 0 ? "now" : `${props.archiveHours} hours after ${formatDateTime(props.workFinishedAt)}`} unless a Critical alert is still open.</p>
      )}
      {props.status !== "active" && <Badge tone="gray">{props.status === "closed" ? "Closed" : "Archived"}</Badge>}
      {props.canManage && (
        <div className="flex flex-wrap gap-2">
          {props.status === "active" ? (
            <>
              {props.syncStatus === "ok" && <Button size="sm" variant="secondary" loading={busy} icon={<RefreshCw className="size-4" />} onClick={() => run(resyncWorkspace(props.conversationId))}>Recalculate members</Button>}
              <Button size="sm" variant="danger" onClick={() => { setReason(""); setClosing(true); }}>Close workspace</Button>
            </>
          ) : (
            <Button size="sm" loading={busy} onClick={() => run(reopenWorkspace(props.conversationId))}>Reopen</Button>
          )}
        </div>
      )}
      {props.status !== "active" && props.canManage && <p className="text-xs text-muted">Reopening recalculates drivers from current assignments. Drivers who were removed earlier do not get access back.</p>}
      <ConfirmDialog
        open={closing}
        onOpenChange={setClosing}
        title="Close this workspace?"
        description="Drivers lose access immediately and receive nothing new. Staff keep the history. You can reopen it later."
        confirmLabel="Close workspace"
        tone="danger"
        onConfirm={async () => {
          const r = await closeWorkspace({ conversationId: props.conversationId, reason });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Closed.");
          setClosing(false);
          router.refresh();
        }}
      >
        <Field label="Reason (optional)" htmlFor="close-reason">
          <Input id="close-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
