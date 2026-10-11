"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, Pencil, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { DOCUMENT_KINDS, OWNERSHIP } from "@/lib/fleet/availability";
import { archiveVehicleDocument, assignTruckDriver, saveVehicleDocument, setOwnership } from "@/app/(app)/fleet/actions";

type Vehicle = { kind: "truck" | "trailer"; id: string };

/** Choose the driver whose primary truck this is. Reassigning moves the truck in one step. */
export function AssignDriverForm({ truckId, current, drivers, restricted }: {
  truckId: string;
  current: { id: string; name: string } | null;
  drivers: Array<{ id: string; name: string; truck: string | null }>;
  restricted: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState("");
  const chosen = drivers.find((d) => d.id === choice);
  const run = (driverId: string | null) => start(async () => {
    const r = await assignTruckDriver(truckId, driverId);
    if (!r.ok) toast.error(r.error);
    else { toast.success(r.message ?? "Saved."); setChoice(""); router.refresh(); }
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label={current ? "Reassign to" : "Assign a driver"} htmlFor="assign-driver" className="min-w-56 flex-1">
          <Select id="assign-driver" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={pending}>
            <option value="">Choose a driver…</option>
            {drivers.filter((d) => d.id !== current?.id).map((d) => (
              <option key={d.id} value={d.id}>{d.name}{d.truck ? ` (now on ${d.truck})` : ""}</option>
            ))}
          </Select>
        </Field>
        <Button disabled={!choice || pending} loading={pending && Boolean(choice)} onClick={() => run(choice)}>{current ? "Reassign" : "Assign"}</Button>
        {current && (
          <Button variant="secondary" disabled={pending} icon={<UserMinus className="size-4" />} onClick={() => {
            if (window.confirm(`Remove ${current.name} from this truck? They will have no primary truck.`)) run(null);
          }}>Remove driver</Button>
        )}
      </div>
      {chosen?.truck && <p className="text-sm text-muted">{chosen.name} leaves truck {chosen.truck}; it will have no primary driver.</p>}
      {current && choice && <p className="text-sm text-muted">{current.name} will have no primary truck.</p>}
      {restricted && <p className="text-sm text-muted">The truck is restricted for safety: a primary driver does not make it dispatch-ready.</p>}
    </div>
  );
}

export function OwnershipForm({ vehicle, value }: { vehicle: Vehicle; value: string | null }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(setOwnership.bind(null, vehicle), {
    onSuccess: (r) => { toast.success(r.message ?? "Saved."); router.refresh(); },
  });
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2" noValidate>
      <Field label="Ownership" htmlFor="ownership" className="min-w-48">
        <Select id="ownership" name="ownership" defaultValue={value ?? ""}>
          <option value="">Not recorded</option>
          {Object.entries(OWNERSHIP).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
      <Button type="submit" variant="secondary" loading={pending}>Save ownership</Button>
      <div className="basis-full"><FormError message={formError} /></div>
    </form>
  );
}

export interface DocumentValues {
  id: string;
  kind: string;
  title: string;
  reference_number: string;
  issuing_authority: string;
  issued_on: string | null;
  expires_on: string | null;
  notes: string;
}

/** Add a document, or edit one (pass `doc`). */
export function DocumentForm({ vehicle, doc, onDone }: { vehicle: Vehicle; doc?: DocumentValues; onDone?: () => void }) {
  const router = useRouter();
  const [key, setKey] = useState(0);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const { pending, onSubmit, fieldError, formError } = useFormAction(saveVehicleDocument.bind(null, vehicle, doc?.id ?? null), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setKey((k) => k + 1);
      setSubmissionKey(crypto.randomUUID());
      onDone?.();
      router.refresh();
    },
  });
  const p = doc ? `doc-${doc.id}-` : "doc-new-";
  const f = (name: string) => ({ id: `${p}${name}`, name, ...describedBy(`${p}${name}`, fieldError(name)) });
  return (
    <form key={key} onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-6" noValidate>
      {!doc && <input type="hidden" name="submission_key" value={submissionKey} />}
      <div className="sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Document" htmlFor={`${p}kind`} required error={fieldError("kind")} className="sm:col-span-2">
        <Select {...f("kind")} defaultValue={doc?.kind ?? "registration"}>
          {Object.entries(DOCUMENT_KINDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </Field>
      <Field label="Name (for “Other”)" htmlFor={`${p}title`} error={fieldError("title")} className="sm:col-span-2">
        <Input {...f("title")} defaultValue={doc?.title} maxLength={120} />
      </Field>
      <Field label="Number" htmlFor={`${p}reference_number`} error={fieldError("reference_number")} className="sm:col-span-2" hint="Registration, policy or permit number.">
        <Input {...f("reference_number")} defaultValue={doc?.reference_number} maxLength={80} />
      </Field>
      <Field label="Issued by" htmlFor={`${p}issuing_authority`} error={fieldError("issuing_authority")} className="sm:col-span-2">
        <Input {...f("issuing_authority")} defaultValue={doc?.issuing_authority} maxLength={120} placeholder="State, insurer, lessor…" />
      </Field>
      <Field label="Issued on" htmlFor={`${p}issued_on`} error={fieldError("issued_on")} className="sm:col-span-2">
        <DateInput {...f("issued_on")} defaultValue={doc?.issued_on ?? ""} />
      </Field>
      <Field label="Expires on" htmlFor={`${p}expires_on`} error={fieldError("expires_on")} className="sm:col-span-2">
        <DateInput {...f("expires_on")} defaultValue={doc?.expires_on ?? ""} />
      </Field>
      <Field label="Notes" htmlFor={`${p}notes`} error={fieldError("notes")} className="sm:col-span-6">
        <Textarea {...f("notes")} defaultValue={doc?.notes} rows={2} maxLength={2000} />
      </Field>
      <div className="flex gap-2 sm:col-span-6">
        <Button type="submit" variant={doc ? "primary" : "secondary"} loading={pending}>{doc ? "Save document" : "Add document"}</Button>
        {doc && onDone && <Button variant="ghost" onClick={onDone}>Cancel</Button>}
      </div>
    </form>
  );
}

export function DocumentRowActions({ vehicle, doc }: { vehicle: Vehicle; doc: DocumentValues }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  if (editing) return <div className="mt-3 rounded-md border border-line p-3"><DocumentForm vehicle={vehicle} doc={doc} onDone={() => setEditing(false)} /></div>;
  return (
    <div className="flex gap-1">
      <Button size="sm" variant="ghost" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(true)} aria-label={`Edit ${DOCUMENT_KINDS[doc.kind as keyof typeof DOCUMENT_KINDS] ?? "document"}`}>Edit</Button>
      <Button size="sm" variant="ghost" disabled={pending} icon={<Archive className="size-3.5" />} onClick={() => {
        if (!window.confirm("Archive this document? It stays in the history but no longer counts as current.")) return;
        start(async () => {
          const r = await archiveVehicleDocument(vehicle, doc.id);
          if (!r.ok) toast.error(r.error);
          else { toast.success(r.message ?? "Archived."); router.refresh(); }
        });
      }}>Archive</Button>
    </div>
  );
}
