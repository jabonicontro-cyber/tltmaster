"use client";

import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Checkbox, Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { TRAILER_TYPE_LABELS, TRAILER_TYPES, TRUCK_TYPE_LABELS, TRUCK_TYPES, trimNumber } from "@/lib/fleet/labels";
import type { EquipmentFormValues } from "./form-defaults";
import { BaseField, type BaseOption } from "@/components/bases/base-field";

const trim = (v: string | number | null | undefined) => (v == null ? "" : trimNumber(v));

interface Props {
  kind: "truck" | "trailer";
  initial: EquipmentFormValues;
  action: (formData: FormData) => Promise<ActionResult<{ id: string }>>;
  cancelHref: string;
  submitLabel: string;
  /** Trailers: trucks to pair with. */
  trucks?: Array<{ id: string; unit_number: string; active: boolean }>;
  /** Active dispatch bases (the picker shows only with two or more) and the current one. */
  bases?: BaseOption[];
  baseId?: string | null;
}

export function EquipmentForm({ kind, initial, action, cancelHref, submitLabel, trucks = [], bases, baseId }: Props) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(action);
  const f = (name: string) => ({ id: name, name, ...describedBy(name, fieldError(name)) });
  const [weight, setWeight] = useState(trim(initial.weight_capacity));
  const [weightUnit, setWeightUnit] = useState<string>(initial.weight_unit ?? "");
  const [volume, setVolume] = useState(trim(initial.volume_capacity));
  const [verified, setVerified] = useState(initial.capacity_verified);
  const hasCapacity = Boolean(weight.trim() || volume.trim());
  const typeName = kind === "truck" ? "truck_type" : "trailer_type";

  // Editing a verified capacity clears "verified": the new values must be confirmed again.
  const capacityChanged = (fn: () => void) => {
    fn();
    setVerified(false);
  };

  return (
    <form data-guard-unsaved onSubmit={onSubmit} className="space-y-6" noValidate>
      <FormError message={formError} />

      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">{kind === "truck" ? "Truck" : "Trailer"}</legend>
        <Field label="Unit number" htmlFor="unit_number" required error={fieldError("unit_number")} className="sm:col-span-2" hint="As painted on the equipment">
          <Input {...f("unit_number")} defaultValue={initial.unit_number} maxLength={20} required autoFocus data-guide={kind === "truck" ? "truck-unit" : undefined} />
        </Field>
        <Field label="Type" htmlFor={typeName} required error={fieldError(typeName)} className="sm:col-span-4">
          <Select {...f(typeName)} defaultValue={initial.type}>
            <option value="">Choose…</option>
            {kind === "truck"
              ? TRUCK_TYPES.map((t) => <option key={t} value={t}>{TRUCK_TYPE_LABELS[t]}</option>)
              : TRAILER_TYPES.map((t) => <option key={t} value={t}>{TRAILER_TYPE_LABELS[t]}</option>)}
          </Select>
        </Field>
        <Field label="Year" htmlFor="model_year" error={fieldError("model_year")} className="sm:col-span-1">
          <Input {...f("model_year")} defaultValue={initial.model_year ?? ""} inputMode="numeric" maxLength={4} />
        </Field>
        <Field label="Make" htmlFor="make" error={fieldError("make")} className="sm:col-span-2">
          <Input {...f("make")} defaultValue={initial.make} maxLength={60} />
        </Field>
        <Field label="Model" htmlFor="model" error={fieldError("model")} className="sm:col-span-3">
          <Input {...f("model")} defaultValue={initial.model} maxLength={60} />
        </Field>
        <Field label="VIN" htmlFor="vin" error={fieldError("vin")} className="sm:col-span-3">
          <Input {...f("vin")} defaultValue={initial.vin} maxLength={17} className="uppercase tabular" autoComplete="off" />
        </Field>
        <Field label="License plate" htmlFor="license_plate" error={fieldError("license_plate")} className="sm:col-span-2">
          <Input {...f("license_plate")} defaultValue={initial.license_plate} maxLength={15} className="uppercase" />
        </Field>
        <Field label="State" htmlFor="plate_state" error={fieldError("plate_state")} className="sm:col-span-1">
          <Input {...f("plate_state")} defaultValue={initial.plate_state} maxLength={2} className="uppercase" />
        </Field>
      <BaseField bases={bases} defaultValue={baseId} className="sm:col-span-3" />
      </fieldset>

      <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
        <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Capacity</legend>
        <div className="sm:col-span-6">
          <Notice title="Only enter capacities you have confirmed">
            Leave a capacity blank if it is not known — it will show as <strong>Unknown</strong>. Never estimate. Mark it verified only after checking a scale ticket,
            registration or manufacturer specification, and note the source.
          </Notice>
        </div>
        <Field label="Weight capacity (payload)" htmlFor="weight_capacity" error={fieldError("weight_capacity")} className="sm:col-span-2">
          <Input {...f("weight_capacity")} value={weight} onChange={(e) => capacityChanged(() => setWeight(e.target.value))} inputMode="decimal" className="text-right tabular" placeholder="Unknown" />
        </Field>
        <Field label="Unit" htmlFor="weight_unit" error={fieldError("weight_unit")} className="sm:col-span-1">
          <Select {...f("weight_unit")} value={weightUnit} onChange={(e) => capacityChanged(() => setWeightUnit(e.target.value))}>
            <option value="">—</option>
            <option value="ton">Tons</option>
            <option value="lb">Pounds</option>
          </Select>
        </Field>
        <Field label="Body volume (cubic yards)" htmlFor="volume_capacity" error={fieldError("volume_capacity")} className="sm:col-span-3">
          <Input {...f("volume_capacity")} value={volume} onChange={(e) => capacityChanged(() => setVolume(e.target.value))} inputMode="decimal" className="max-w-40 text-right tabular" placeholder="Unknown" />
        </Field>
        <Field label="Source" htmlFor="capacity_source" error={fieldError("capacity_source")} className="sm:col-span-4" hint="e.g. Scale ticket 3/14, registration, manufacturer spec">
          <Input {...f("capacity_source")} defaultValue={initial.capacity_source} maxLength={200} />
        </Field>
        <div className="flex items-end sm:col-span-2">
          <div>
            <Checkbox
              id="capacity_verified"
              name="capacity_verified"
              checked={verified}
              disabled={!hasCapacity}
              onChange={(e) => setVerified(e.target.checked)}
              label="I have verified these capacities"
            />
            {fieldError("capacity_verified") && <p className="mt-1 text-sm text-red-700">{fieldError("capacity_verified")}</p>}
          </div>
        </div>
      </fieldset>

      {kind === "trailer" && (
        <fieldset className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Compatibility</legend>
          <div className="sm:col-span-6">
            <p className="mb-2 text-sm font-semibold text-ink">Truck types that can pull this trailer</p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {TRUCK_TYPES.map((t) => (
                <Checkbox key={t} name="compatible_truck_types" value={t} defaultChecked={initial.compatible_truck_types?.includes(t)} label={TRUCK_TYPE_LABELS[t]} />
              ))}
            </div>
            <p className="mt-1 text-sm text-muted">Leave all unchecked if not known — compatibility will show as not recorded.</p>
          </div>
          <Field label="Usually paired with truck" htmlFor="default_truck_id" error={fieldError("default_truck_id")} className="sm:col-span-2" hint="The trailer keeps its own service status.">
            <Select {...f("default_truck_id")} defaultValue={initial.default_truck_id ?? ""}>
              <option value="">No usual truck</option>
              {trucks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.unit_number}
                  {t.active ? "" : " (inactive)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Compatibility notes" htmlFor="compatibility_notes" error={fieldError("compatibility_notes")} className="sm:col-span-4">
            <Input {...f("compatibility_notes")} defaultValue={initial.compatibility_notes ?? ""} maxLength={1000} placeholder="e.g. Needs air-ride hitch" />
          </Field>
        </fieldset>
      )}

      <Field label="Notes" htmlFor="notes" error={fieldError("notes")}>
        <Textarea {...f("notes")} defaultValue={initial.notes} rows={3} maxLength={4000} />
      </Field>

      <div className="flex justify-end gap-2">
        <ButtonLink href={cancelHref} variant="ghost">Cancel</ButtonLink>
        <Button type="submit" loading={pending}>{submitLabel}</Button>
      </div>
    </form>
  );
}
