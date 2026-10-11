"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { updateMyProfile } from "@/app/(app)/profile/actions";

/** Display name and phone — the two things a person may change about themselves. Input is kept if saving fails. */
export function ProfileForm({ displayName, phone, fullName }: { displayName: string; phone: string; fullName: string }) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(updateMyProfile, { onSuccess: (r) => toast.success(r.message ?? "Profile saved.") });
  return (
    <form onSubmit={onSubmit} className="max-w-md space-y-4" noValidate>
      <FormError message={formError} />
      <Field label="Name to show" htmlFor="display_name" error={fieldError("display_name")} hint={fullName ? `Leave empty to use "${fullName}".` : "How the app greets you and shows you to colleagues."}>
        <Input id="display_name" name="display_name" defaultValue={displayName} maxLength={60} autoComplete="nickname" aria-invalid={Boolean(fieldError("display_name"))} />
      </Field>
      <Field label="Phone" htmlFor="phone" error={fieldError("phone")} hint="Optional. Visible to you and your company administrators.">
        <Input id="phone" name="phone" type="tel" inputMode="tel" defaultValue={phone} maxLength={25} autoComplete="tel" aria-invalid={Boolean(fieldError("phone"))} />
      </Field>
      <Button type="submit" loading={pending} disabled={pending} className="min-h-11">Save</Button>
    </form>
  );
}
