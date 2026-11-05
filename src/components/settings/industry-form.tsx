"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { INDUSTRIES, INDUSTRY_HINTS, INDUSTRY_LABELS, type Industry } from "@/lib/industry";
import { saveIndustry } from "@/app/(app)/settings/actions";

/** What the company hauls (MK1): changes the words people see, such as delivery tickets or bills of lading. */
export function IndustryForm({ industry, canEdit }: { industry: Industry; canEdit: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(saveIndustry, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="space-y-4 p-5 sm:p-6" noValidate data-guard-unsaved aria-label="What you haul">
      <div>
        <h2 className="text-base font-semibold text-ink">What you haul</h2>
        <p className="mt-1 text-sm text-muted">Sets the words Taviron uses, like delivery tickets or bills of lading. Everything else works the same.</p>
      </div>
      <FormError message={formError} />
      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-3" disabled={!canEdit}>
        <legend className="sr-only">What you haul</legend>
        {INDUSTRIES.map((i) => (
          <label key={i} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-strong has-[:checked]:bg-surface">
            <input type="radio" name="industry" value={i} defaultChecked={industry === i} className="mt-0.5 size-4" />
            <span>
              <span className="block text-sm font-semibold text-ink">{INDUSTRY_LABELS[i]}</span>
              <span className="block text-xs text-muted">{INDUSTRY_HINTS[i]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {canEdit && <Button type="submit" loading={pending}>Save</Button>}
    </form>
  );
}
