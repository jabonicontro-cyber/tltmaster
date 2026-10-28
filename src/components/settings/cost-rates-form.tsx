"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { saveCostRates } from "@/app/(app)/settings/actions";

const dollars = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));

/**
 * The company's own cost rates (B104). Profit per load in Reports is revenue minus these, applied to each load's planned
 * hours; empty rates leave profit uncalculated rather than guessed.
 */
export function CostRatesForm({ rates, canEdit }: { rates: { truck_hour_cents: number | null; driver_hour_cents: number | null; per_load_cents: number | null } | null; canEdit: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(saveCostRates, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3" noValidate data-guard-unsaved aria-label="Cost rates">
      <div className="sm:col-span-3"><FormError message={formError} /></div>
      <Field label="Truck cost per hour ($)" htmlFor="cr-truck" hint="Fuel, payments, insurance, maintenance: your own figure.">
        <Input id="cr-truck" name="truck_hour" inputMode="decimal" defaultValue={dollars(rates?.truck_hour_cents ?? null)} disabled={!canEdit} />
      </Field>
      <Field label="Driver cost per hour ($)" htmlFor="cr-driver" hint="Wages and payroll costs.">
        <Input id="cr-driver" name="driver_hour" inputMode="decimal" defaultValue={dollars(rates?.driver_hour_cents ?? null)} disabled={!canEdit} />
      </Field>
      <Field label="Fixed cost per load ($)" htmlFor="cr-load" hint="Tolls, scale fees or anything charged per load.">
        <Input id="cr-load" name="per_load" inputMode="decimal" defaultValue={dollars(rates?.per_load_cents ?? null)} disabled={!canEdit} />
      </Field>
      {canEdit && <div className="sm:col-span-3"><Button type="submit" loading={pending}>Save cost rates</Button></div>}
    </form>
  );
}
