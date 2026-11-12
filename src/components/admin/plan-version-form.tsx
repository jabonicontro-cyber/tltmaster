"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { savePlanVersion } from "@/app/admin/lifecycle-actions";

/**
 * A new plan price version (PC1). Errors appear next to the field they are about, like every other console form; the
 * browser's own pop-ups are off (noValidate). The server checks everything again (Admins only, here and in the database).
 */
export function PlanVersionForm({ plans }: { plans: Array<[key: string, name: string]> }) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const save = useFormAction(savePlanVersion, {
    onSuccess: (r) => { toast.success(r.message ?? "New price version saved."); router.refresh(); },
  });
  const quoted = key === "custom";
  return (
    <form onSubmit={save.onSubmit} className="space-y-3" noValidate aria-label="New price version">
      <Field label="Plan" htmlFor="plan_key" error={save.fieldError("plan_key")}>
        <Select id="plan_key" name="plan_key" value={key} onChange={(e) => setKey(e.target.value)} aria-invalid={Boolean(save.fieldError("plan_key"))}>
          <option value="" disabled>Choose a plan</option>
          {plans.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Monthly ($)" htmlFor="monthly" error={save.fieldError("monthly")} hint={quoted ? "Optional: quoted per customer" : undefined}>
          <Input id="monthly" name="monthly" inputMode="decimal" placeholder="499" aria-invalid={Boolean(save.fieldError("monthly"))} />
        </Field>
        <Field label="Onboarding ($)" htmlFor="onboarding" error={save.fieldError("onboarding")}>
          <Input id="onboarding" name="onboarding" inputMode="decimal" placeholder="199" aria-invalid={Boolean(save.fieldError("onboarding"))} />
        </Field>
      </div>
      <Field label="First day" htmlFor="effective_from" error={save.fieldError("effective_from")} hint="Today or a later day.">
        <DateInput id="effective_from" name="effective_from" aria-invalid={Boolean(save.fieldError("effective_from"))} />
      </Field>
      <Field label="Note" htmlFor="note"><Input id="note" name="note" maxLength={500} placeholder="Why the price changes" /></Field>
      <div>
        <Checkbox name="confirm" label="I checked these prices and the first day" aria-invalid={Boolean(save.fieldError("confirm"))} />
        {save.fieldError("confirm") ? <p className="mt-1 text-sm text-red-700" role="alert">{save.fieldError("confirm")}</p> : null}
      </div>
      <p className="text-xs text-muted">Companies that already signed keep their price. The public pricing page is not changed by this; update it separately.</p>
      <FormError message={save.formError && Object.keys(save.result && !save.result.ok ? save.result.fieldErrors ?? {} : {}).length === 0 ? save.formError : null} />
      <Button type="submit" loading={save.pending}>Save version</Button>
    </form>
  );
}
