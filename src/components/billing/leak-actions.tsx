"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { checkLeak, reopenLeak } from "@/app/(app)/billing/leaks/actions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";

// Revenue leakage finder (B110): a person marks a finding checked with a reason, or shows it again.

export function CheckLeakButton({ findingKey, label }: { findingKey: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { pending, onSubmit, formError } = useFormAction(checkLeak, {
    onSuccess: (r) => { toast.success(r.message ?? "Saved."); setOpen(false); router.refresh(); },
  });
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Mark ${label} as checked`}>It&apos;s fine</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Mark as checked" description="Hidden until its amount changes. The reason is kept with your name." size="sm">
        <form onSubmit={onSubmit} className="space-y-3" noValidate aria-label="Mark as checked">
          <input type="hidden" name="key" value={findingKey} />
          <FormError message={formError} />
          <Field label="Why is this fine?" htmlFor={`lk-${findingKey}`} required hint="For example: agreed discount, billed separately">
            <Input id={`lk-${findingKey}`} name="reason" maxLength={300} required />
          </Field>
          <Button type="submit" loading={pending}>Mark as checked</Button>
        </form>
      </Dialog>
    </>
  );
}

export function ReopenLeakButton({ findingKey }: { findingKey: string }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(reopenLeak, {
    onSuccess: (r) => { toast.success(r.message ?? "Saved."); router.refresh(); },
  });
  return (
    <form onSubmit={onSubmit} className="inline-flex items-center gap-2">
      <input type="hidden" name="key" value={findingKey} />
      <Button type="submit" size="sm" variant="ghost" loading={pending}>Show again</Button>
      <FormError message={formError} />
    </form>
  );
}
