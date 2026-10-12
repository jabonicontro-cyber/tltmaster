"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Hash } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { DEPARTMENTS } from "@/lib/employees";
import type { Person } from "@/server/data/communications";
import { createChannel } from "@/app/(app)/communications/actions";
import { PeoplePicker } from "./people-picker";

export function NewChannel({ people, me }: { people: Person[]; me: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState("");
  const [addDepartment, setAddDepartment] = useState(true);
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <>
      <Button icon={<Hash className="size-4" />} onClick={() => { setOpen(true); setError(null); }}>New channel</Button>
      <Dialog open={open} onOpenChange={setOpen} title="New channel" description="A standing conversation for a department or topic." size="lg"
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button loading={pending} onClick={async () => {
            setPending(true); setError(null);
            const r = await createChannel({ title, description, department: department ? (department as keyof typeof DEPARTMENTS) : null, addDepartment: Boolean(department) && addDepartment, members });
            setPending(false);
            if (!r.ok) return setError(r.error);
            toast.success(r.message ?? "Channel created.");
            setOpen(false);
            router.push(`/communications/c/${r.data.id}`);
          }}>Create channel</Button>
        </>}>
        <div className="space-y-4">
          <Field label="Name" htmlFor="ch-title" required><Input id="ch-title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Description" htmlFor="ch-desc"><Textarea id="ch-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <Field label="Department" htmlFor="ch-dept" hint="Optional. People's departments come from their employee records.">
            <Select id="ch-dept" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">No department</option>
              {Object.entries(DEPARTMENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          {department && <Checkbox label="Add everyone currently in this department" checked={addDepartment} onChange={(e) => setAddDepartment(e.target.checked)} />}
          <div>
            <p className="mb-1 text-sm font-semibold text-ink">Other members</p>
            <PeoplePicker people={people} selected={members} onChange={setMembers} exclude={[me]} />
          </div>
          <FormError message={error} />
        </div>
      </Dialog>
    </>
  );
}
