"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { setPrimaryTruck } from "@/app/(app)/employees/actions";

/** Set or clear a driver's primary (everyday) truck. Needs fleet.assign; trucks held by another driver are shown but not selectable. */
export function PrimaryTruckPicker({ employeeId, driverId, current, trucks }: { employeeId: string; driverId: string; current: string | null; trucks: Array<{ id: string; unit: string; heldBy: string | null }> }) {
  const [value, setValue] = useState(current ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    start(async () => {
      setError(null);
      const r = await setPrimaryTruck(employeeId, driverId, value || null);
      if (r.ok) toast.success(r.message ?? "Saved.");
      else setError(r.error);
    });
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="block text-sm font-semibold text-ink" htmlFor="primary_truck">
        Primary truck
        <Select id="primary_truck" className="mt-1 sm:w-72" value={value} onChange={(e) => setValue(e.target.value)} disabled={pending}>
          <option value="">Unassigned</option>
          {trucks.map((t) => (
            <option key={t.id} value={t.id} disabled={Boolean(t.heldBy) && t.id !== current}>
              {t.unit}{t.heldBy && t.id !== current ? ` — primary truck of ${t.heldBy}` : ""}
            </option>
          ))}
        </Select>
      </label>
      <Button type="button" variant="secondary" onClick={save} loading={pending} disabled={pending || value === (current ?? "")}>Save truck</Button>
      {error && <p role="alert" className="text-sm font-medium text-critical">{error}</p>}
    </div>
  );
}
