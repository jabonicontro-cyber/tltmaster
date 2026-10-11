"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { recordReading, saveSchedule } from "@/app/(app)/maintenance/actions";

type Truck = { id: string; unit_number: string };

/** Add a preventive schedule: any of days, miles or engine hours; whichever comes first. */
export function ScheduleForm({ trucks, defaultTruck }: { trucks: Truck[]; defaultTruck?: string }) {
  const router = useRouter();
  const [formKey, setFormKey] = useState(0);
  const { pending, onSubmit, fieldError, formError } = useFormAction(saveSchedule, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setFormKey((k) => k + 1);
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `pm-${name}`, name, ...describedBy(`pm-${name}`, fieldError(name)) });
  return (
    <form key={formKey} onSubmit={onSubmit} className="space-y-4" noValidate>
      <FormError message={formError} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
        <Field label="Truck" htmlFor="pm-truck_id" required error={fieldError("truck_id")} className="sm:col-span-2">
          <Select {...f("truck_id")} defaultValue={defaultTruck ?? ""}>
            <option value="">Choose a truck…</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
          </Select>
        </Field>
        <Field label="Service" htmlFor="pm-name" required error={fieldError("name")} className="sm:col-span-4" hint="For example “Oil and filter” or “Annual DOT inspection”.">
          <Input {...f("name")} maxLength={80} />
        </Field>
        <Field label="Every … days" htmlFor="pm-interval_days" error={fieldError("interval_days")} className="sm:col-span-2">
          <Input {...f("interval_days")} inputMode="numeric" />
        </Field>
        <Field label="Every … miles" htmlFor="pm-interval_miles" error={fieldError("interval_miles")} className="sm:col-span-2">
          <Input {...f("interval_miles")} inputMode="decimal" />
        </Field>
        <Field label="Every … engine hours" htmlFor="pm-interval_hours" error={fieldError("interval_hours")} className="sm:col-span-2">
          <Input {...f("interval_hours")} inputMode="decimal" />
        </Field>
        <Field label="Last done on" htmlFor="pm-last_done_on" error={fieldError("last_done_on")} className="sm:col-span-2" hint="Leave empty if unknown — the schedule shows as “not enough data”.">
          <DateInput {...f("last_done_on")} />
        </Field>
        <Field label="Odometer when last done" htmlFor="pm-last_done_miles" error={fieldError("last_done_miles")} className="sm:col-span-2">
          <Input {...f("last_done_miles")} inputMode="decimal" />
        </Field>
        <Field label="Engine hours when last done" htmlFor="pm-last_done_hours" error={fieldError("last_done_hours")} className="sm:col-span-2">
          <Input {...f("last_done_hours")} inputMode="decimal" />
        </Field>
        <Field label="Warn … days before" htmlFor="pm-warn_days" error={fieldError("warn_days")} className="sm:col-span-2">
          <Input {...f("warn_days")} inputMode="numeric" placeholder="14" />
        </Field>
        <Field label="Warn … miles before" htmlFor="pm-warn_miles" error={fieldError("warn_miles")} className="sm:col-span-2">
          <Input {...f("warn_miles")} inputMode="decimal" placeholder="500" />
        </Field>
        <Field label="Warn … hours before" htmlFor="pm-warn_hours" error={fieldError("warn_hours")} className="sm:col-span-2">
          <Input {...f("warn_hours")} inputMode="decimal" placeholder="25" />
        </Field>
      </div>
      <Button type="submit" loading={pending}>Add schedule</Button>
    </form>
  );
}

/** Record a reading. The database refuses a value lower than the last one. */
export function ReadingForm({ trucks }: { trucks: Truck[] }) {
  const router = useRouter();
  const [formKey, setFormKey] = useState(0);
  const { pending, onSubmit, fieldError, formError } = useFormAction(recordReading, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      setFormKey((k) => k + 1);
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: `rd-${name}`, name, ...describedBy(`rd-${name}`, fieldError(name)) });
  return (
    <form key={formKey} onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-6" noValidate>
      <div className="sm:col-span-6"><FormError message={formError} /></div>
      <Field label="Truck" htmlFor="rd-truck_id" required error={fieldError("truck_id")} className="sm:col-span-2">
        <Select {...f("truck_id")} defaultValue="">
          <option value="">Choose a truck…</option>
          {trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
        </Select>
      </Field>
      <Field label="Odometer (mi)" htmlFor="rd-odometer_miles" error={fieldError("odometer_miles")} className="sm:col-span-2">
        <Input {...f("odometer_miles")} inputMode="decimal" />
      </Field>
      <Field label="Engine hours" htmlFor="rd-engine_hours" error={fieldError("engine_hours")} className="sm:col-span-2">
        <Input {...f("engine_hours")} inputMode="decimal" />
      </Field>
      <div className="sm:col-span-6">
        <Button type="submit" variant="secondary" loading={pending}>Record reading</Button>
      </div>
    </form>
  );
}
