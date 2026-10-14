"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormError, Input, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { WEEKDAYS } from "@/lib/employees";
import { saveWorkSchedule } from "@/app/(app)/employees/actions";

export type WorkSchedule = Record<`${(typeof WEEKDAYS)[number][0]}_hours`, number>;

/** Hours per weekday. Full-day time off counts these hours (people with employees.edit change them). */
export function WorkScheduleForm({ employeeId, initial, canEdit }: { employeeId: string; initial: WorkSchedule | null; canEdit: boolean }) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(saveWorkSchedule.bind(null, employeeId), { onSuccess: (r) => toast.success(r.message ?? "Saved.") });
  const total = initial ? WEEKDAYS.reduce((a, [d]) => a + Number(initial[`${d}_hours`] ?? 0), 0) : null;
  if (!canEdit) {
    return initial ? (
      <dl className="grid grid-cols-7 gap-2 text-center text-sm" aria-label="Work schedule">
        {WEEKDAYS.map(([d, label]) => (
          <div key={d}><dt className="text-muted">{label}</dt><dd className="font-medium tabular">{Number(initial[`${d}_hours`])} h</dd></div>
        ))}
      </dl>
    ) : <p className="text-sm text-muted">No work schedule recorded, so full-day time off asks for its hours.</p>;
  }
  return (
    <form data-guard-unsaved onSubmit={onSubmit} className="space-y-3" noValidate aria-label="Work schedule">
      <FormError message={formError} />
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {WEEKDAYS.map(([d, label]) => {
          const name = `${d}_hours`;
          return (
            <label key={d} className="text-sm">
              <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
              <Input id={name} name={name} inputMode="decimal" defaultValue={initial ? String(Number(initial[name as keyof WorkSchedule])) : ""} placeholder="0" aria-label={`${label} hours`} {...describedBy(name, fieldError(name))} />
              {fieldError(name) && <span className="mt-0.5 block text-xs text-critical">{fieldError(name)}</span>}
            </label>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" loading={pending} disabled={pending}>Save schedule</Button>
        <span className="text-xs text-muted">{total !== null ? `${Number(total.toFixed(2))} h a week. ` : ""}Full-day time off counts these hours; empty means 0 (a day off).</span>
      </div>
    </form>
  );
}
