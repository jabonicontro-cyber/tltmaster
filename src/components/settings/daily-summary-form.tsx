"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { saveDailySummary } from "@/app/(app)/settings/actions";

const hourLabel = (h: number) => new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, h)));

/** End-of-day owner summary (B97): off until switched on here. */
export function DailySummaryForm({ enabled, hour, canEdit, demo }: { enabled: boolean; hour: number; canEdit: boolean; demo: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(saveDailySummary, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate data-guard-unsaved aria-label="End-of-day summary">
      <FormError message={formError} />
      <label className="flex min-h-10 items-center gap-2 text-sm font-semibold">
        <input type="checkbox" name="enabled" defaultChecked={enabled} disabled={!canEdit || demo} className="size-4" />
        Email the owners an end-of-day summary
      </label>
      <div className="flex flex-wrap items-end gap-4">
      <Field label="Not before" htmlFor="ds-hour" hint="Company time.">
        <Select id="ds-hour" name="hour" defaultValue={String(hour)} disabled={!canEdit || demo}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
        </Select>
      </Field>
      {canEdit && !demo ? <Button type="submit" loading={pending}>Save</Button> : null}
      </div>
    </form>
  );
}
