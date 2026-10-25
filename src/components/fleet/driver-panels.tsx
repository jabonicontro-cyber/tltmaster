"use client";

import { useRouter } from "next/navigation";
import { DateInput } from "@/components/ui/date-input";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, describedBy } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/states";
import { useFormAction } from "@/components/ui/use-form-action";
import { formatDate, formatDateTime } from "@/lib/dates";
import { CDL_CLASSES, QUALIFICATION_KINDS, QUALIFICATION_LABELS, qualificationName } from "@/lib/fleet/labels";
import type { QualificationKind, QualificationRow } from "@/server/data/types";
import { deleteQualification, saveQualification, setDriverActive } from "@/app/(app)/fleet/actions";
import { QualificationBadge } from "./fleet-badges";

export function DriverActions({ id, name, active, canEdit }: { id: string; name: string; active: boolean; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  if (!canEdit) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <ButtonLink href={`/fleet/drivers/${id}/edit`} variant="secondary" icon={<Pencil className="size-4" />}>
        Edit
      </ButtonLink>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {active ? "Mark inactive" : "Reactivate"}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={active ? `Mark ${name} inactive?` : `Reactivate ${name}?`}
        description={
          active
            ? "Inactive drivers are hidden from lists and never eligible for assignments. Their qualifications and history are kept."
            : "The driver appears in lists again. Eligibility still depends on current qualifications."
        }
        confirmLabel={active ? "Mark inactive" : "Reactivate"}
        tone={active ? "danger" : "primary"}
        onConfirm={async () => {
          const r = await setDriverActive(id, !active);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      />
    </div>
  );
}

interface PanelProps {
  driverId: string;
  qualifications: QualificationRow[];
  today: string;
  soon: string;
  timezone: string;
  names: Record<string, string>;
  canEdit: boolean;
}

export function QualificationsPanel({ driverId, qualifications, today, soon, timezone, names, canEdit }: PanelProps) {
  const router = useRouter();
  const [editing, setEditing] = useState<QualificationRow | "new" | null>(null);
  const [removing, setRemoving] = useState<QualificationRow | null>(null);
  const who = (uid: string | null) => (uid ? names[uid] ?? "Former user" : "");

  return (
    <Card>
      <CardHeader
        title="Licenses and qualifications"
        description="A driver is eligible only with a verified, unexpired CDL (class B, or class A for trailers) and a verified, unexpired DOT medical card. License numbers are not stored."
        actions={
          canEdit && (
            <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              Add
            </Button>
          )
        }
      />
      {qualifications.length === 0 ? (
        <EmptyState title="No qualifications recorded" description="Without a recorded CDL and medical card this driver is not eligible for assignments." />
      ) : (
        <ul className="divide-y divide-line">
          {qualifications.map((q) => (
            <li key={q.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 sm:px-6">
              <div className="min-w-0 space-y-1">
                <p className="font-semibold">
                  {qualificationName(q)}
                  {q.endorsements && <span className="ml-2 text-sm font-normal text-muted">Endorsements: {q.endorsements}</span>}
                </p>
                <QualificationBadge q={q} today={today} soon={soon} />
                <p className="text-sm text-muted">
                  {[q.issuing_state && `Issued in ${q.issuing_state}`, q.issued_on && `on ${formatDate(q.issued_on)}`].filter(Boolean).join(" ")}
                  {q.verified_at && ` · Verified ${formatDateTime(q.verified_at, timezone)}${who(q.verified_by) ? ` by ${who(q.verified_by)}` : ""}`}
                </p>
                {q.notes && <p className="text-sm">{q.notes}</p>}
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Edit ${qualificationName(q)}`} onClick={() => setEditing(q)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${qualificationName(q)}`} onClick={() => setRemoving(q)}>
                    <Trash2 className="size-4 text-red-700" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <QualificationDialog
          driverId={driverId}
          qualification={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            toast.success(message);
            router.refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={removing ? `Remove ${qualificationName(removing)}?` : ""}
        description="Only remove entries made by mistake. Keep expired qualifications — add the renewed one as a new entry. The removal is recorded in the history."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={async () => {
          if (!removing) return;
          const r = await deleteQualification(driverId, removing.id);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Removed");
          router.refresh();
        }}
      />
    </Card>
  );
}

function QualificationDialog({ driverId, qualification, onClose, onSaved }: { driverId: string; qualification: QualificationRow | null; onClose: () => void; onSaved: (message: string) => void }) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(saveQualification.bind(null, driverId, qualification?.id ?? null), {
    onSuccess: (r) => onSaved(r.message ?? "Saved"),
  });
  const f = (name: string) => ({ id: `q-${name}`, name, ...describedBy(`q-${name}`, fieldError(name)) });
  const [kind, setKind] = useState<QualificationKind>(qualification?.kind ?? "cdl");
  const [verified, setVerified] = useState(Boolean(qualification?.verified_at));
  // Changing the document's details means it must be verified again.
  const changed = () => setVerified(false);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={qualification ? "Edit qualification" : "Add qualification"} size="md">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <Field label="Type" htmlFor="q-kind" required error={fieldError("kind")} className="sm:col-span-3">
            <Select {...f("kind")} value={kind} onChange={(e) => { setKind(e.target.value as QualificationKind); changed(); }}>
              {QUALIFICATION_KINDS.map((k) => (
                <option key={k} value={k}>{QUALIFICATION_LABELS[k]}</option>
              ))}
            </Select>
          </Field>
          {kind === "cdl" && (
            <Field label="Class" htmlFor="q-cdl_class" required error={fieldError("cdl_class")} className="sm:col-span-1">
              <Select {...f("cdl_class")} defaultValue={qualification?.cdl_class ?? ""} onChange={changed}>
                <option value="">—</option>
                {CDL_CLASSES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </Field>
          )}
          {kind === "other" && (
            <Field label="Description" htmlFor="q-description" required error={fieldError("description")} className="sm:col-span-4">
              <Input {...f("description")} defaultValue={qualification?.description ?? ""} maxLength={120} />
            </Field>
          )}
          {kind === "cdl" && (
            <Field label="Endorsements" htmlFor="q-endorsements" error={fieldError("endorsements")} className="sm:col-span-2" hint="e.g. N, T, X">
              <Input {...f("endorsements")} defaultValue={qualification?.endorsements ?? ""} maxLength={60} className="uppercase" onChange={changed} />
            </Field>
          )}
          <Field label="Issuing state" htmlFor="q-issuing_state" error={fieldError("issuing_state")} className="sm:col-span-2">
            <Input {...f("issuing_state")} defaultValue={qualification?.issuing_state ?? "IN"} maxLength={2} className="uppercase" onChange={changed} />
          </Field>
          <Field label="Issued" htmlFor="q-issued_on" error={fieldError("issued_on")} className="sm:col-span-2">
            <DateInput min="1900-01-01" {...f("issued_on")} defaultValue={qualification?.issued_on ?? ""} onChange={changed} />
          </Field>
          <Field label="Expires" htmlFor="q-expires_on" error={fieldError("expires_on")} className="sm:col-span-2" hint="Leave blank only if unknown — it will not count as valid.">
            <DateInput min="1900-01-01" {...f("expires_on")} defaultValue={qualification?.expires_on ?? ""} onChange={changed} />
          </Field>
          <Field label="Notes" htmlFor="q-notes" error={fieldError("notes")} className="sm:col-span-4">
            <Input {...f("notes")} defaultValue={qualification?.notes ?? ""} maxLength={1000} />
          </Field>
        </div>
        <div className="rounded-xl border border-line bg-surface/60 p-3">
          <Checkbox name="verified" checked={verified} onChange={(e) => setVerified(e.target.checked)} label="I have seen the original document and the details above match it" />
          <p className="mt-1 text-sm text-muted">Your name and the time are recorded. Unverified qualifications do not count toward eligibility.</p>
        </div>
        {qualification?.verified_at && !verified && <Badge tone="amber">Will be saved as not verified</Badge>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={pending}>{qualification ? "Save" : "Add qualification"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
