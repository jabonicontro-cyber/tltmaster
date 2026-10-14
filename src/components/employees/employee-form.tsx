"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button, ButtonLink } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { PhoneInput } from "@/components/ui/phone-input";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { DEPARTMENTS, EMPLOYEE_STATUSES, EMPLOYMENT_TYPES } from "@/lib/employees";
import { AVATAR_KEYS, avatarUrl } from "@/lib/people/avatars";
import { ROLE_LABELS, ROLES } from "@/lib/permissions";

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
  avatar_key: string;
}

export const EMPTY_EMPLOYEE: EmployeeFormValues = {
  full_name: "", job_title: "", department: "operations", employment_type: "full_time", status: "active",
  hire_date: "", end_date: "", work_email: "", work_phone: "", emergency_contact_name: "", emergency_contact_phone: "", notes: "", avatar_key: "",
};

/**
 * Employment details. When adding a person, `signIn` (for people who manage users) also offers "Send them a Taviron
 * sign-in", ticked by default (owner 2026-10-14), with the role it gives. Editing never changes access; the person's
 * page has the Access section for that.
 */
export function EmployeeForm({ initial, action, cancelHref, submitLabel, signIn }: { initial: EmployeeFormValues; action: (fd: FormData) => Promise<ActionResult<{ id: string }>>; cancelHref: string; submitLabel: string; signIn?: { isOwner: boolean } }) {
  const router = useRouter();
  const [sendSignIn, setSendSignIn] = useState(Boolean(signIn));
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
        <Field label="Job title" htmlFor="job_title" error={fieldError("job_title")} className="sm:col-span-3" hint="Describes the job only. What the person can do in Taviron comes from their role.">
          <Input {...f("job_title")} defaultValue={initial.job_title} maxLength={80} />
        </Field>
        <Field label="Work email" htmlFor="work_email" error={fieldError("work_email")} className="sm:col-span-3">
          <Input {...f("work_email")} type="email" defaultValue={initial.work_email} autoComplete="off" />
        </Field>
        <Field label="Work phone" htmlFor="work_phone" error={fieldError("work_phone")} className="sm:col-span-3">
          <PhoneInput {...f("work_phone")} defaultValue={initial.work_phone} autoComplete="off" />
        </Field>
      </fieldset>
      {signIn && (
        <fieldset className="space-y-3 rounded-lg border border-line bg-surface p-4">
          <legend className="sr-only">Taviron sign-in</legend>
          <label className="flex items-start gap-3">
            <input type="checkbox" name="send_signin" checked={sendSignIn} onChange={(e) => setSendSignIn(e.target.checked)} className="mt-1 size-4 rounded border-line accent-brand" />
            <span>
              <span className="block font-semibold text-ink">Send them a Taviron sign-in</span>
              <span className="block text-sm text-muted">They get an email to set a password, sent to the work email. Untick for people who never use Taviron; you can invite them later.</span>
            </span>
          </label>
          {sendSignIn && (
            <Field label="Role" htmlFor="role" error={fieldError("role")} hint="Decides what they can see and do. Change it later on their page." className="max-w-xs">
              <Select {...f("role")} defaultValue="driver">
                {ROLES.filter((r) => r !== "owner" || signIn.isOwner).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </Select>
            </Field>
          )}
        </fieldset>
      )}
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
      <fieldset>
        <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase">Avatar</legend>
        <p className="mb-2 text-sm text-muted">Shown in the directory when the person has no photo of their own. People with a login can also choose one on their profile.</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar">
          <label className="flex size-12 cursor-pointer items-center justify-center rounded-full border border-line text-xs text-muted has-[:checked]:ring-2 has-[:checked]:ring-strong">
            <input type="radio" name="avatar_key" value="" defaultChecked={!initial.avatar_key} className="sr-only" />None
          </label>
          {AVATAR_KEYS.map((key, i) => (
            <label key={key} className="cursor-pointer rounded-full has-[:checked]:ring-2 has-[:checked]:ring-strong has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-strong">
              <input type="radio" name="avatar_key" value={key} defaultChecked={initial.avatar_key === key} className="sr-only" aria-label={`Avatar ${i + 1}`} />
              {/* eslint-disable-next-line @next/next/no-img-element -- static illustration */}
              <img src={avatarUrl(key)} alt="" width={48} height={48} className="size-12 rounded-full" />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending} disabled={pending}>{submitLabel}</Button>
        <ButtonLink href={cancelHref} variant="secondary">Cancel</ButtonLink>
      </div>
    </form>
  );
}
