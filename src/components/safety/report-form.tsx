"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Camera } from "lucide-react";
import { toast } from "sonner";
import { reportIncident } from "@/app/(app)/safety/actions";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { INCIDENT_KINDS, INCIDENT_SEVERITIES } from "@/lib/safety";

type Option = { value: string; label: string };

/**
 * Report a safety incident (B103). Office staff choose the driver; a driver's own record is set by the database. Photos
 * (up to 8) are sent one by one after the report is saved, so a failed photo never loses the report.
 */
export function IncidentReportForm({ today, now, trucks, drivers, chooseDriver, done }: {
  today: string;
  /** "14:05" in company time. */
  now: string;
  trucks: Option[];
  drivers: Option[];
  /** Office staff pick the driver; drivers report as themselves. */
  chooseDriver: boolean;
  /** Where to go after saving ("{id}" is replaced by the new incident). */
  done: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);

  const submit = (form: FormData) =>
    start(async () => {
      setError(null);
      setFieldErrors({});
      const r = await reportIncident({
        kind: String(form.get("kind") ?? "") as never,
        severity: String(form.get("severity") ?? "minor") as never,
        date: String(form.get("date") ?? ""),
        time: String(form.get("time") ?? ""),
        location: String(form.get("location") ?? ""),
        description: String(form.get("description") ?? ""),
        injury: form.get("injury") === "on",
        vehicle_damage: form.get("vehicle_damage") === "on",
        truck_id: String(form.get("truck_id") ?? ""),
        driver_id: String(form.get("driver_id") ?? ""),
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      let failed = 0;
      for (const file of files.slice(0, 8)) {
        const body = new FormData();
        body.set("incident", r.data.id);
        body.set("file", file);
        const res = await fetch("/safety/photos", { method: "POST", body }).catch(() => null);
        if (!res?.ok) failed++;
      }
      if (failed) toast.warning(`${r.message} ${failed} photo${failed === 1 ? "" : "s"} could not be sent.`);
      else toast.success(r.message ?? "Reported.");
      router.push(done.replace("{id}", r.data.id));
      router.refresh();
    });

  return (
    <form action={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What happened" htmlFor="kind" required error={fieldErrors.kind}>
          <Select id="kind" name="kind" defaultValue="" required>
            <option value="" disabled>Choose…</option>
            {Object.entries(INCIDENT_KINDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="How serious" htmlFor="severity">
          <Select id="severity" name="severity" defaultValue="minor">
            {Object.entries(INCIDENT_SEVERITIES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Date" htmlFor="date" required error={fieldErrors.date}>
          <DateInput id="date" name="date" defaultValue={today} max={today} required />
        </Field>
        <Field label="Time" htmlFor="time" required error={fieldErrors.time}>
          <Input id="time" name="time" type="time" defaultValue={now} required />
        </Field>
      </div>
      <Field label="Where" htmlFor="location" hint="Site, road or yard area.">
        <Input id="location" name="location" maxLength={300} />
      </Field>
      <Field label="Describe what happened" htmlFor="description" required error={fieldErrors.description}>
        <Textarea id="description" name="description" rows={4} maxLength={4000} required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Truck" htmlFor="truck_id">
          <Select id="truck_id" name="truck_id" defaultValue="">
            <option value="">None</option>
            {trucks.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
        </Field>
        {chooseDriver && (
          <Field label="Driver" htmlFor="driver_id">
            <Select id="driver_id" name="driver_id" defaultValue="">
              <option value="">None</option>
              {drivers.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </Select>
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Checkbox name="injury" label="Someone was hurt" />
        <Checkbox name="vehicle_damage" label="A vehicle was damaged" />
      </div>
      <Field label="Photos (optional, up to 8)" htmlFor="photos">
        <label htmlFor="photos" className="flex min-h-12 cursor-pointer items-center gap-2 rounded-control border border-dashed border-line bg-surface px-3 text-sm text-muted hover:border-strong/40">
          <Camera className="size-4" aria-hidden />
          {files.length ? `${files.length} photo${files.length === 1 ? "" : "s"} chosen` : "Take or choose photos"}
        </label>
        <input id="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" className="sr-only" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 8))} />
      </Field>
      <FormError message={error} />
      <Button type="submit" disabled={pending} className="min-h-12 w-full justify-center sm:w-auto">{pending ? "Sending…" : "Report incident"}</Button>
    </form>
  );
}
