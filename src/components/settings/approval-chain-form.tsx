"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { ROLE_LABELS, ROLES } from "@/lib/permissions";
import { saveApprovalChain } from "@/app/(app)/settings/actions";

/**
 * Time-off approval chain (settings.manage): ordered steps, each decided by a role that also has the time-off approval
 * permission. No steps = one approval by anyone with that permission. Saving restarts pending requests at step 1.
 */
export function ApprovalChainForm({ steps, canEdit }: { steps: Array<{ role: string; label: string }>; canEdit: boolean }) {
  const router = useRouter();
  const [rows, setRows] = useState(steps.length ? steps : []);
  const { pending, onSubmit, formError } = useFormAction(saveApprovalChain, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate data-guard-unsaved>
      <FormError message={formError} />
      <input type="hidden" name="steps" value={JSON.stringify(rows)} />
      {rows.length === 0 && <p className="text-sm text-muted">No chain: one approval by anyone with the time-off approval permission.</p>}
      <ol className="space-y-2" aria-label="Approval steps">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[3rem_1fr_1fr_auto]">
            <span className="text-sm font-semibold text-muted">Step {i + 1}</span>
            <Field label="Decided by" htmlFor={`step-role-${i}`}>
              <Select id={`step-role-${i}`} value={r.role} disabled={!canEdit} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>
                {ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
              </Select>
            </Field>
            <Field label="Step name" htmlFor={`step-label-${i}`}>
              <Input id={`step-label-${i}`} value={r.label} maxLength={60} disabled={!canEdit} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </Field>
            {canEdit && <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>}
          </li>
        ))}
      </ol>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {rows.length < 5 && <Button type="button" variant="secondary" size="sm" onClick={() => setRows([...rows, { role: "owner", label: "" }])}>Add a step</Button>}
          <Button type="submit" loading={pending}>Save approval chain</Button>
        </div>
      )}
    </form>
  );
}
