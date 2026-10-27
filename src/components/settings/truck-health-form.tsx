"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { saveTruckHealthRules } from "@/app/(app)/settings/actions";
import type { HealthRules } from "@/lib/fleet/health";

/** The company's truck health rules (B93). An open safety-critical defect or Out of service is always At risk. */
export function TruckHealthForm({ rules, canEdit }: { rules: HealthRules; canEdit: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(saveTruckHealthRules, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-4" noValidate data-guard-unsaved aria-label="Truck health rules">
      <div className="sm:col-span-4"><FormError message={formError} /></div>
      <Field label="At risk from this many repairs" htmlFor="th-at-risk" hint="Unplanned repairs in 90 days. Default 2; 0 turns it off.">
        <Input id="th-at-risk" name="at_risk_repairs" type="number" min={0} max={99} defaultValue={rules.at_risk_repairs} disabled={!canEdit} />
      </Field>
      <Field label="Watch from this many repairs" htmlFor="th-watch" hint="Default 1; 0 turns it off.">
        <Input id="th-watch" name="watch_repairs" type="number" min={0} max={99} defaultValue={rules.watch_repairs} disabled={!canEdit} />
      </Field>
      <Field label="Watch from this many open repairs" htmlFor="th-open" hint="Open work orders that are not safety-critical. Default 2.">
        <Input id="th-open" name="watch_open" type="number" min={0} max={99} defaultValue={rules.watch_open} disabled={!canEdit} />
      </Field>
      <Field label="Overdue service" htmlFor="th-service" hint="Preventive service past due. Default: Watch.">
        <Select id="th-service" name="service_overdue" defaultValue={rules.service_overdue} disabled={!canEdit}>
          <option value="watch">Watch</option>
          <option value="at_risk">At risk</option>
          <option value="off">Not counted</option>
        </Select>
      </Field>
      {canEdit && <div className="sm:col-span-4"><Button type="submit" loading={pending}>Save truck health rules</Button></div>}
    </form>
  );
}
