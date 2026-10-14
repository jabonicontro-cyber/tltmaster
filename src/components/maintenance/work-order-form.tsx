"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button, ButtonLink } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { WO_CATEGORIES, WO_URGENCIES } from "@/lib/maintenance";

export interface WorkOrderFormValues {
  truck_id: string;
  title: string;
  description: string;
  category: string;
  urgency: string;
  safety_critical: boolean;
  driver_id: string;
  assigned_to: string;
  scheduled_for: string;
  due_on: string;
  field_report_id: string;
  // Edit only
  findings?: string;
  labor_hours?: string;
  odometer_at_service?: string;
  engine_hours_at_service?: string;
  edit_seq?: number;
}

interface Options {
  trucks: Array<{ id: string; unit_number: string; out_of_service: boolean }>;
  drivers: Array<{ id: string; name: string; primary_truck_id: string | null }>;
  assignees: Array<{ id: string; name: string }>;
}

/**
 * Create or edit a work order. Marking it safety-critical takes the truck out
 * of service until an authorized inspection clears it (the form says so
 * before saving).
 */
export function WorkOrderForm({ mode, initial, options, action, cancelHref }: {
  mode: "create" | "edit";
  initial: WorkOrderFormValues;
  options: Options;
  action: (fd: FormData) => Promise<ActionResult<{ id: string }>>;
  cancelHref: string;
}) {
  const router = useRouter();
  // One key per form instance: a double click or a retry after a lost response never creates two work orders.
  const [submissionKey] = useState(() => crypto.randomUUID());
  const [truckId, setTruckId] = useState(initial.truck_id);
  const [driverId, setDriverId] = useState(initial.driver_id);
  const [safety, setSafety] = useState(initial.safety_critical);
  const { pending, onSubmit, fieldError, formError } = useFormAction(action, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.push(`/maintenance/work-orders/${r.data.id}`);
      router.refresh();
    },
  });
  const f = (name: string) => ({ id: name, name, ...describedBy(name, fieldError(name)) });
  const primaryDriver = options.drivers.find((d) => d.primary_truck_id && d.primary_truck_id === truckId);

  return (
    <form data-guard-unsaved onSubmit={onSubmit} className="space-y-6" noValidate>
      <FormError message={formError} />
      {mode === "create" && <input type="hidden" name="submission_key" value={submissionKey} />}
      {mode === "edit" && <input type="hidden" name="edit_seq" value={initial.edit_seq} />}
      {initial.field_report_id && <input type="hidden" name="field_report_id" value={initial.field_report_id} />}
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">The job</legend>
        {mode === "create" ? (
          <Field label="Truck" htmlFor="truck_id" required error={fieldError("truck_id")} className="sm:col-span-2">
            <Select {...f("truck_id")} value={truckId} onChange={(e) => {
              setTruckId(e.target.value);
              const d = options.drivers.find((x) => x.primary_truck_id === e.target.value);
              if (d && !driverId) setDriverId(d.id);
            }}>
              <option value="">Choose a truck…</option>
              {options.trucks.map((t) => <option key={t.id} value={t.id}>{t.unit_number}{t.out_of_service ? " (out of service)" : ""}</option>)}
            </Select>
          </Field>
        ) : null}
        <Field label="Title" htmlFor="title" required error={fieldError("title")} className={mode === "create" ? "sm:col-span-4" : "sm:col-span-6"} hint="A few words, for example “Air leak at rear axle”.">
          <Input {...f("title")} defaultValue={initial.title} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Description" htmlFor="description" error={fieldError("description")} className="sm:col-span-6">
          <Textarea {...f("description")} defaultValue={initial.description} rows={3} maxLength={4000} />
        </Field>
        <Field label="Category" htmlFor="category" error={fieldError("category")} className="sm:col-span-2">
          <Select {...f("category")} defaultValue={initial.category}>{Object.entries(WO_CATEGORIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="Urgency" htmlFor="urgency" error={fieldError("urgency")} className="sm:col-span-2">
          <Select {...f("urgency")} defaultValue={initial.urgency}>{Object.entries(WO_URGENCIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </Field>
        <Field label="Driver (optional)" htmlFor="driver_id" error={fieldError("driver_id")} className="sm:col-span-2"
          hint={mode === "create" && primaryDriver ? `Primary truck of ${primaryDriver.name}.` : undefined}>
          <Select {...f("driver_id")} value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">No driver</option>
            {options.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-6">
          <Checkbox id="safety_critical" name="safety_critical" checked={safety} onChange={(e) => setSafety(e.target.checked)}
            label="Safety-critical defect (brakes, steering, tires, lights, load securement…)" />
          {safety && (
            <p role="note" className="mt-2 rounded-md border border-critical/40 bg-critical/5 px-3 py-2 text-sm text-ink">
              Saving takes the truck <strong>out of service</strong>. It returns to service only after someone authorized records a passed inspection.
            </p>
          )}
        </div>
      </fieldset>
      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Shop</legend>
        <Field label="Mechanic" htmlFor="assigned_to" error={fieldError("assigned_to")} className="sm:col-span-2">
          <Select {...f("assigned_to")} defaultValue={initial.assigned_to}>
            <option value="">Unassigned</option>
            {options.assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </Field>
        <Field label="Scheduled for" htmlFor="scheduled_for" error={fieldError("scheduled_for")} className="sm:col-span-2" hint="The driver of this truck sees it on My Day.">
          <DateInput {...f("scheduled_for")} defaultValue={initial.scheduled_for} />
        </Field>
        <Field label="Due by" htmlFor="due_on" error={fieldError("due_on")} className="sm:col-span-2">
          <DateInput {...f("due_on")} defaultValue={initial.due_on} />
        </Field>
      </fieldset>
      {mode === "edit" && (
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Findings and labor</legend>
          <Field label="Findings" htmlFor="findings" error={fieldError("findings")} className="sm:col-span-6">
            <Textarea {...f("findings")} defaultValue={initial.findings} rows={3} maxLength={4000} />
          </Field>
          <Field label="Labor hours" htmlFor="labor_hours" error={fieldError("labor_hours")} className="sm:col-span-2">
            <Input {...f("labor_hours")} inputMode="decimal" defaultValue={initial.labor_hours} />
          </Field>
          <Field label="Odometer at service (mi)" htmlFor="odometer_at_service" error={fieldError("odometer_at_service")} className="sm:col-span-2">
            <Input {...f("odometer_at_service")} inputMode="decimal" defaultValue={initial.odometer_at_service} />
          </Field>
          <Field label="Engine hours at service" htmlFor="engine_hours_at_service" error={fieldError("engine_hours_at_service")} className="sm:col-span-2">
            <Input {...f("engine_hours_at_service")} inputMode="decimal" defaultValue={initial.engine_hours_at_service} />
          </Field>
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending}>{mode === "create" ? "Create work order" : "Save changes"}</Button>
        <ButtonLink href={cancelHref} variant="ghost">Cancel</ButtonLink>
      </div>
    </form>
  );
}
