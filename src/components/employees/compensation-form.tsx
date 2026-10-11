"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { PAY_TYPES } from "@/lib/employees";
import { saveCompensation } from "@/app/(app)/employees/actions";

/** Confidential pay details; rendered only for people with employees.compensation (and checked again on the server and in the database). */
export function CompensationForm({ employeeId, initial }: { employeeId: string; initial: { pay_type: string; rate: string; rate_percent: string; effective_date: string; notes: string } }) {
  const [payType, setPayType] = useState(initial.pay_type || "hourly");
  const { pending, onSubmit, fieldError, formError } = useFormAction(saveCompensation.bind(null, employeeId), { onSuccess: (r) => toast.success(r.message ?? "Saved.") });
  const f = (name: string) => ({ id: name, name, ...describedBy(name, fieldError(name)) });
  return (
    <form data-guard-unsaved onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-6" noValidate>
      <div className="sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Pay type" htmlFor="pay_type" className="sm:col-span-2" error={fieldError("pay_type")}>
        <Select {...f("pay_type")} value={payType} onChange={(e) => setPayType(e.target.value)}>{Object.entries(PAY_TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
      </Field>
      {payType === "percentage" ? (
        <Field label="Percentage" htmlFor="rate_percent" className="sm:col-span-2" error={fieldError("rate_percent")}>
          <Input {...f("rate_percent")} inputMode="decimal" defaultValue={initial.rate_percent} />
        </Field>
      ) : (
        <Field label="Rate ($)" htmlFor="rate" className="sm:col-span-2" error={fieldError("rate")}>
          <Input {...f("rate")} inputMode="decimal" defaultValue={initial.rate} />
        </Field>
      )}
      {payType === "percentage" ? <input type="hidden" name="rate" value="" /> : <input type="hidden" name="rate_percent" value="" />}
      <Field label="Effective from" htmlFor="effective_date" className="sm:col-span-2" error={fieldError("effective_date")}>
        <DateInput {...f("effective_date")} defaultValue={initial.effective_date} />
      </Field>
      <Field label="Notes" htmlFor="notes" className="sm:col-span-6" error={fieldError("notes")}>
        <Textarea {...f("notes")} rows={2} defaultValue={initial.notes} maxLength={2000} />
      </Field>
      <div className="sm:col-span-6"><Button type="submit" loading={pending} disabled={pending}>Save pay details</Button></div>
    </form>
  );
}
