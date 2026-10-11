"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button, ButtonLink } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { PhoneInput } from "@/components/ui/phone-input";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { DEPARTMENTS, EMPLOYEE_STATUSES, EMPLOYMENT_TYPES } from "@/lib/employees";

export interface EmployeeFormValues {
  full_name: string;
  job_title: string;
  department: string;
  employment_type: string;
  status: string;
  hire_date: string;
  end_date: string;
  work_email: string;
  work_phone: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  notes: string;
}

export const EMPTY_EMPLOYEE: EmployeeFormValues = {
  full_name: "", job_title: "", department: "operations", employment_type: "full_time", status: "active",
  hire_date: "", end_date: "", work_email: "", work_phone: "", emergency_contact_name: "", emergency_contact_phone: "", notes: "",
};

/** Employment details only. Roles and sign-in access are managed in Settings → Users. */
export function EmployeeForm({ initial, action, cancelHref, submitLabel }: { initial: EmployeeFormValues; action: (fd: FormData) => Promise<ActionResult<{ id: string }>>; cancelHref: string; submitLabel: string }) {
  const router = useRouter();
  const { pending, onSubmit, fieldError, formError } = useFormAction(action, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.push(`/employees/${r.data.id}`);
    },
  });
  const f = (name: string) => ({ id: name, name, ...describedBy(name, fieldError(name)) });
  return (
    <form data-guard-unsaved onSubmit={onSubmit} className="space-y-6" noValidate>
      <FormError message={formError} />
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase sm:col-span-6">Person</legend>
        <Field label="Full name" htmlFor="full_name" required error={fieldError("full_name")} className="sm:col-span-3">
          <Input {...f("full_name")} defaultValue={initial.full_name} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Job title" htmlFor="job_title" error={fieldError("job_title")} className="sm:col-span-3" hint="Describes the job only. Permissions come from the person's role in Settings → Users.">
          <Input {...f("job_title")} defaultValue={initial.job_title} maxLength={80} />
        </Field>
        <Field label="Work email" htmlFor="work_email" error={fieldError("work_email")} className="sm:col-span-3">
          <Input {...f("work_email")} type="email" defaultValue={initial.work_email} autoComplete="off" />
        </Field>
        <Field label="Work phone" htmlFor="work_phone" error={fieldError("work_phone")} className="sm:col-span-3">
          <PhoneInput {...f("work_phone")} defaultValue={initial.work_phone} autoComplete="off" />
        </Field>
      </fieldset>
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase sm:col-span-6">Employment</legend>
        <Field label="Department" htmlFor="department" error={fieldError("department")} className="sm:col-span-2">
          <Select {...f("department")} defaultValue={initial.department}>{Object.entries(DEPARTMENTS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="Employment type" htmlFor="employment_type" error={fieldError("employment_type")} className="sm:col-span-2">
          <Select {...f("employment_type")} defaultValue={initial.employment_type}>{Object.entries(EMPLOYMENT_TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="Status" htmlFor="status" error={fieldError("status")} className="sm:col-span-2">
          <Select {...f("status")} defaultValue={initial.status}>{Object.entries(EMPLOYEE_STATUSES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="Hire date" htmlFor="hire_date" error={fieldError("hire_date")} className="sm:col-span-3">
          <DateInput {...f("hire_date")} defaultValue={initial.hire_date} />
        </Field>
        <Field label="Last day (when employment ends)" htmlFor="end_date" error={fieldError("end_date")} className="sm:col-span-3">
          <DateInput {...f("end_date")} defaultValue={initial.end_date} />
        </Field>
      </fieldset>
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase sm:col-span-6">Emergency contact</legend>
        <Field label="Name" htmlFor="emergency_contact_name" error={fieldError("emergency_contact_name")} className="sm:col-span-3">
          <Input {...f("emergency_contact_name")} defaultValue={initial.emergency_contact_name} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Phone" htmlFor="emergency_contact_phone" error={fieldError("emergency_contact_phone")} className="sm:col-span-3">
          <PhoneInput {...f("emergency_contact_phone")} defaultValue={initial.emergency_contact_phone} autoComplete="off" />
        </Field>
        <Field label="Notes" htmlFor="notes" error={fieldError("notes")} className="sm:col-span-6">
          <Textarea {...f("notes")} defaultValue={initial.notes} rows={3} maxLength={4000} />
        </Field>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending} disabled={pending}>{submitLabel}</Button>
        <ButtonLink href={cancelHref} variant="secondary">Cancel</ButtonLink>
      </div>
    </form>
  );
}
