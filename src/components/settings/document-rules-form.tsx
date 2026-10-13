"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { saveDocumentRules } from "@/app/(app)/settings/actions";

const KINDS = [
  { key: "insurance", label: "Insurance", hint: "Default: block." },
  { key: "registration", label: "Registration", hint: "Default: block." },
  { key: "inspection", label: "Inspection", hint: "Default: warn." },
  { key: "permit", label: "Permit", hint: "Default: warn." },
] as const;

/**
 * What an expired vehicle document does to dispatch, per kind (settings.manage). Only a verified expired document
 * blocks; an unverified one always warns so a person confirms the record. Applies to Smart Dispatch, Plan the day
 * and every assignment the database checks.
 */
export function DocumentRulesForm({ rules, canEdit }: { rules: Record<string, "block" | "warn">; canEdit: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(saveDocumentRules, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-4" noValidate data-guard-unsaved>
      <div className="sm:col-span-4"><FormError message={formError} /></div>
      {KINDS.map((k) => (
        <Field key={k.key} label={k.label} htmlFor={`rule-${k.key}`} hint={k.hint}>
          <Select id={`rule-${k.key}`} name={k.key} defaultValue={rules[k.key]} disabled={!canEdit}>
            <option value="block">Block assignment</option>
            <option value="warn">Warn only</option>
          </Select>
        </Field>
      ))}
      {canEdit && <div className="sm:col-span-4"><Button type="submit" loading={pending}>Save document rules</Button></div>}
    </form>
  );
}
