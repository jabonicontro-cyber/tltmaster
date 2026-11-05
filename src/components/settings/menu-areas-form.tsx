"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { OPTIONAL_AREAS } from "@/lib/menu-areas";
import { saveMenuAreas } from "@/app/(app)/settings/actions";

/** Simple mode (SF1): choose which optional areas show in everyone's menu. Menu only; nothing else changes. */
export function MenuAreasForm({ hidden, canEdit }: { hidden: string[]; canEdit: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(saveMenuAreas, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="space-y-4 p-5 sm:p-6" noValidate data-guard-unsaved aria-label="Areas in the menu">
      <div>
        <h2 className="text-base font-semibold text-ink">Areas in the menu</h2>
        <p className="mt-1 text-sm text-muted">Hide what your company doesn&apos;t use, for everyone. It only tidies the menu: nothing is deleted, permissions stay the same, and safety areas always show.</p>
      </div>
      <FormError message={formError} />
      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3" disabled={!canEdit}>
        <legend className="sr-only">Areas in the menu</legend>
        {OPTIONAL_AREAS.map((a) => (
          <label key={a.href} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-strong">
            <input type="hidden" name="area" value={a.href} />
            <input type="checkbox" name="show" value={a.href} defaultChecked={!hidden.includes(a.href)} className="mt-0.5 size-4" aria-label={`Show ${a.label}`} />
            <span>
              <span className="block text-sm font-semibold text-ink">{a.label}</span>
              <span className="block text-xs text-muted">{a.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {canEdit && <Button type="submit" loading={pending}>Save</Button>}
    </form>
  );
}
