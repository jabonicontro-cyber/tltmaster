"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MessageSquarePlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/form";
import { STATUS_DISCLAIMER } from "@/lib/communications";
import type { Person } from "@/server/data/communications";
import { createGroup, openDirect } from "@/app/(app)/communications/actions";
import { PeoplePicker } from "./people-picker";
import { DrivingNotice } from "./status";

export function NewConversation({ people, canGroup, me }: { people: Person[]; canGroup: boolean; me: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"direct" | "group" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const driving = people.filter((p) => selected.includes(p.user_id) && p.work_status === "active_delivery").map((p) => p.name);

  const start = (m: "direct" | "group") => { setMode(m); setSelected([]); setTitle(""); setError(null); };
  const submit = async () => {
    setPending(true);
    setError(null);
    const r = mode === "direct" ? await openDirect(selected[0] ?? "") : await createGroup({ title, members: selected });
    setPending(false);
    if (!r.ok) return setError(r.error);
    if (r.message) toast.success(r.message);
    setMode(null);
    router.push(`/communications/c/${r.data.id}`);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button icon={<MessageSquarePlus className="size-4" />} onClick={() => start("direct")}>New message</Button>
      {canGroup && <Button variant="secondary" icon={<Users className="size-4" />} onClick={() => start("group")}>New group</Button>}
      <Dialog
        open={mode !== null}
        onOpenChange={(o) => !o && setMode(null)}
        title={mode === "group" ? "New group" : "New message"}
        description={mode === "group" ? "Everyone you add sees messages from when they join." : "A private conversation between the two of you."}
        footer={<>
          <Button variant="secondary" onClick={() => setMode(null)}>Cancel</Button>
          <Button onClick={submit} loading={pending} disabled={selected.length === 0}>{mode === "group" ? "Create group" : "Open conversation"}</Button>
        </>}
      >
        <div className="space-y-4">
          {mode === "group" && (
            <Field label="Group name (optional)" htmlFor="group-title" hint="Without a name, the group is named after its members.">
              <Input id="group-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          )}
          <PeoplePicker people={people} selected={selected} onChange={setSelected} multiple={mode === "group"} exclude={[me]} />
          <DrivingNotice names={driving} />
          <p className="text-xs text-muted">{STATUS_DISCLAIMER}</p>
          <FormError message={error} />
        </div>
      </Dialog>
    </div>
  );
}
