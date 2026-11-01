"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveWaitSettings } from "@/app/(app)/reports/wait-times/actions";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";

/** Settings → Dispatch rules: free time at a stop before a wait counts as long (B111). Empty = none flagged. */
export function WaitTimeForm({ freeMinutes, canEdit }: { freeMinutes: number | null; canEdit: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(saveWaitSettings, { onSuccess: (r) => { toast.success(r.message ?? "Saved."); router.refresh(); } });
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3" aria-label="Wait time">
      <FormError message={formError} />
      <Field label="Free time at a stop (minutes)" htmlFor="wt-free" hint="Leave empty to record waits without flagging any.">
        <Input id="wt-free" name="free_minutes" inputMode="numeric" defaultValue={freeMinutes ?? ""} disabled={!canEdit} className="max-w-32" />
      </Field>
      {canEdit && <Button type="submit" loading={pending}>Save</Button>}
    </form>
  );
}
