"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, FormError } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { setCompanyMfaPolicy } from "@/app/mfa/actions";

export function CompanyMfaPolicyForm({ required, canEdit }: { required: boolean; canEdit: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(setCompanyMfaPolicy, { onSuccess: () => { toast.success("Saved."); router.refresh(); } });
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <FormError message={formError} />
      <Checkbox name="required" defaultChecked={required} disabled={!canEdit} label="Require two-step verification for everyone in this company" />
      <p className="text-sm text-muted">People without an authenticator app are asked to set one up the next time they open Taviron; nobody can use the workspace until they do. Turn it on only after you have set up your own (My profile → Security).</p>
      {canEdit ? <Button type="submit" variant="secondary" loading={pending}>Save</Button> : null}
    </form>
  );
}
