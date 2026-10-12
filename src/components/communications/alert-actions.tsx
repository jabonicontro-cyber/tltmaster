"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { allowedPriorities, PRIORITIES, type Priority } from "@/lib/communications";
import { acknowledgeAlert, reassignAlert, resolveAlert, setAlertPriority } from "@/app/(app)/communications/actions";

type Mode = "ack" | "priority" | "reassign" | "resolve" | null;

export function AlertActions(props: {
  id: string;
  priority: Priority;
  minPriority: Priority;
  open: boolean;
  canAcknowledge: boolean;
  canManage: boolean;
  recipients: Array<{ user_id: string; name: string }>;
  people: Array<{ user_id: string; name: string }>;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [priority, setPriority] = useState<Priority>(props.priority);
  const [from, setFrom] = useState(props.recipients[0]?.user_id ?? "");
  const [to, setTo] = useState("");
  if (!props.open || (!props.canAcknowledge && !props.canManage)) return null;
  const start = (m: Mode) => { setNote(""); setPriority(props.priority); setTo(""); setMode(m); };
  const options = allowedPriorities(props.minPriority);

  return (
    <div className="flex flex-wrap gap-2">
      {props.canAcknowledge && <Button onClick={() => start("ack")}>Acknowledge</Button>}
      {props.canManage && <Button variant="secondary" onClick={() => start("priority")}>Change priority</Button>}
      {props.canManage && props.recipients.length > 0 && <Button variant="secondary" onClick={() => start("reassign")}>Reassign</Button>}
      {props.canManage && <Button variant="secondary" onClick={() => start("resolve")}>Resolve</Button>}
      <ConfirmDialog
        open={mode !== null}
        onOpenChange={(o) => !o && setMode(null)}
        title={mode === "ack" ? "Acknowledge this alert" : mode === "priority" ? "Change priority" : mode === "reassign" ? "Reassign responsibility" : "Resolve this alert"}
        description={mode === "ack" ? "Acknowledging says you have seen it and are responsible. It does not resolve the alert."
          : mode === "priority" ? `This kind of alert cannot be lower than ${PRIORITIES[props.minPriority]}. The change and your reason are recorded.`
          : mode === "reassign" ? "The person you move it from stops being responsible; the new person is notified."
          : "Recipients get a 'Resolved' notification in Taviron. Describe how it was handled."}
        confirmLabel={mode === "ack" ? "Acknowledge" : mode === "priority" ? "Change priority" : mode === "reassign" ? "Reassign" : "Resolve"}
        onConfirm={async () => {
          const r = mode === "ack" ? await acknowledgeAlert({ id: props.id, note })
            : mode === "priority" ? await setAlertPriority({ id: props.id, priority, reason: note })
            : mode === "reassign" ? await reassignAlert({ id: props.id, from, to, reason: note })
            : await resolveAlert({ id: props.id, note });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved.");
          setMode(null);
          router.refresh();
        }}
      >
        <div className="space-y-3">
          {mode === "priority" && (
            <Field label="Priority" htmlFor="al-priority">
              <Select id="al-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {options.map((p) => <option key={p} value={p}>{PRIORITIES[p]}</option>)}
              </Select>
            </Field>
          )}
          {mode === "reassign" && (
            <>
              <Field label="From" htmlFor="al-from">
                <Select id="al-from" value={from} onChange={(e) => setFrom(e.target.value)}>
                  {props.recipients.map((r) => <option key={r.user_id} value={r.user_id}>{r.name}</option>)}
                </Select>
              </Field>
              <Field label="To" htmlFor="al-to">
                <Select id="al-to" value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Choose a person…</option>
                  {props.people.filter((p) => p.user_id !== from).map((p) => <option key={p.user_id} value={p.user_id}>{p.name}</option>)}
                </Select>
              </Field>
            </>
          )}
          <Field label={mode === "ack" ? "Note (optional)" : mode === "resolve" ? "How was it resolved?" : "Reason"} htmlFor="al-note">
            {mode === "resolve" ? <Textarea id="al-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              : <Input id="al-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </ConfirmDialog>
    </div>
  );
}
