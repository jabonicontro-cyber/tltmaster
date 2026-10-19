"use client";

import { PhoneInput } from "@/components/ui/phone-input";
import { useState } from "react";
import { DateInput } from "@/components/ui/date-input";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import type { DriverFormValues } from "./form-defaults";
import { BaseField, type BaseOption } from "@/components/bases/base-field";

interface Props {
  initial: DriverFormValues;
  /** Company users who can be linked (not linked to another driver). */
  users: Array<{ id: string; name: string }>;
  action: (formData: FormData) => Promise<ActionResult<{ id: string }>>;
  cancelHref: string;
  submitLabel: string;
  /** Active dispatch bases (the picker shows only with two or more) and the current one. */
  bases?: BaseOption[];
  baseId?: string | null;
}

export function DriverForm({ initial, users, action, cancelHref, submitLabel, bases, baseId }: Props) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(action);
  const f = (name: string) => ({ id: name, name, ...describedBy(name, fieldError(name)) });
  const [userId, setUserId] = useState(initial.user_id ?? "");

  return (
    <form data-guard-unsaved onSubmit={onSubmit} className="space-y-6" noValidate>
      <FormError message={formError} />
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Driver</legend>
        <Field
          label="Linked user account"
          htmlFor="user_id"
          error={fieldError("user_id")}
          className="sm:col-span-3"
          hint="If the driver already has a login, link it so the person is not entered twice. Their name comes from their account."
        >
          <Select {...f("user_id")} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">No account — enter the name below</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.name}</option>
            ))}
          </Select>
        </Field>
        <Field
          label={userId ? "Name (used only if the account has no name)" : "Name"}
          htmlFor="name"
          required={!userId}
          error={fieldError("name")}
          className="sm:col-span-3"
        >
          <Input {...f("name")} defaultValue={initial.name} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Employee number" htmlFor="employee_number" error={fieldError("employee_number")} className="sm:col-span-2">
          <Input {...f("employee_number")} defaultValue={initial.employee_number} maxLength={20} />
        </Field>
        <Field label="Phone" htmlFor="phone" error={fieldError("phone")} className="sm:col-span-2">
          <PhoneInput {...f("phone")} defaultValue={initial.phone} maxLength={40} />
        </Field>
        <Field label="Hire date" htmlFor="hire_date" error={fieldError("hire_date")} className="sm:col-span-2">
          <DateInput min="1900-01-01" {...f("hire_date")} defaultValue={initial.hire_date ?? ""} />
        </Field>
      <BaseField bases={bases} defaultValue={baseId} className="sm:col-span-3" />
      </fieldset>
      <Field label="Notes" htmlFor="notes" error={fieldError("notes")}>
        <Textarea {...f("notes")} defaultValue={initial.notes} rows={3} maxLength={4000} />
      </Field>
      <div className="flex justify-end gap-2">
        <ButtonLink href={cancelHref} variant="ghost">Cancel</ButtonLink>
        <Button type="submit" loading={pending}>{submitLabel}</Button>
      </div>
    </form>
  );
}
