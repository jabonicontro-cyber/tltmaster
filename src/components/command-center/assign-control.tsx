"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UserRoundPlus, UserRoundX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/form";
import type { ExceptionKind } from "@/lib/command-center/rules";
import { assignException, unassignException } from "@/app/(app)/command-center/actions";

export interface Person {
  user_id: string;
  name: string;
  kinds: ExceptionKind[];
}

/** Assign an open item to someone who can resolve it. This never closes the item. */
/** `compact`: icon-only buttons (the queue tiles); the label stays the accessible name and the tooltip. */
export function AssignControl({ itemKey, kind, title, assignedTo, people, compact = false }: { itemKey: string; kind: ExceptionKind; title: string; assignedTo: string | null; people: Person[]; compact?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [note, setNote] = useState("");
  const eligible = people.filter((p) => p.kinds.includes(kind) && p.user_id !== assignedTo);

  return (
    <div className={compact ? "flex gap-0.5" : "flex flex-wrap gap-2"}>
      <Button size="sm" variant="ghost" icon={<UserRoundPlus className="size-4" />} title={compact ? (assignedTo ? "Reassign" : "Assign") : undefined} className={compact ? "px-2.5" : undefined} onClick={() => { setUserId(""); setNote(""); setOpen(true); }}>
        <span className={compact ? "sr-only" : undefined}>{assignedTo ? "Reassign" : "Assign"}</span>
      </Button>
      {assignedTo && (
        <Button
          size="sm"
          variant="ghost"
          icon={<UserRoundX className="size-4" />}
          title={compact ? "Remove assignee" : undefined}
          className={compact ? "px-2.5" : undefined}
          onClick={async () => {
            const r = await unassignException({ key: itemKey });
            if (!r.ok) toast.error(r.error);
            else { toast.success(r.message ?? "Saved"); router.refresh(); }
          }}
        >
          <span className={compact ? "sr-only" : undefined}>Remove assignee</span>
        </Button>
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Assign to a person"
        description={`${title}. The item stays open until it is fixed in its own module; assigning only says who will handle it.`}
        confirmLabel="Assign"
        onConfirm={async () => {
          if (!userId) return "Choose a person.";
          const r = await assignException({ key: itemKey, userId, note });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      >
        <Field label="Person" htmlFor={`assignee-${itemKey}`} required hint="Only people whose role can resolve this kind of item are listed.">
          <Select id={`assignee-${itemKey}`} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose…</option>
            {eligible.map((p) => (
              <option key={p.user_id} value={p.user_id}>{p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Note (optional)" htmlFor={`assign-note-${itemKey}`}>
          <Input id={`assign-note-${itemKey}`} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
