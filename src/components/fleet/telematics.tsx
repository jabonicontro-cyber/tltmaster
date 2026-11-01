"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createFeedKey, recordHours, recordPosition, revokeFeedKey, saveTelematicsSettings } from "@/app/(app)/fleet/locations/actions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import { DUTY_LABEL, SOURCE_OPTIONS, type DutyStatus, type TelematicsSource } from "@/lib/telematics";

// GPS and hours (B101). Every button calls a server action that the database checks again.

function useAction(action: (f: FormData) => Promise<ActionResult>, done?: () => void) {
  const router = useRouter();
  return useFormAction(action, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      done?.();
      router.refresh();
    },
  });
}

export interface Option { id: string; label: string }

/** Record a truck's last known location by hand (dispatch). "Use this device's location" fills it from the browser. */
export function RecordPositionButton({ trucks, defaultTruck }: { trucks: Option[]; defaultTruck?: string }) {
  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [locating, setLocating] = useState(false);
  const { pending, onSubmit, formError } = useAction(recordPosition, () => setOpen(false));
  const locate = () => {
    if (!navigator.geolocation) return toast.error("This device can't share its location.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setLat(p.coords.latitude.toFixed(5)); setLng(p.coords.longitude.toFixed(5)); setLocating(false); },
      () => { toast.error("Location not available. Enter it by hand."); setLocating(false); },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Record a location</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Record a truck's location" description="Where the truck was last known to be, from a call or the provider's screen. Shown as entered by you, with its time." size="sm">
        <form onSubmit={onSubmit} className="space-y-3" noValidate aria-label="Record a location">
          <FormError message={formError} />
          <Field label="Truck" htmlFor="tp-truck" required>
            <Select id="tp-truck" name="truck" defaultValue={defaultTruck ?? ""} required>
              <option value="" disabled>Choose a truck</option>
              {trucks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Latitude" htmlFor="tp-lat" required><Input id="tp-lat" name="latitude" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="40.4237" required /></Field>
            <Field label="Longitude" htmlFor="tp-lng" required><Input id="tp-lng" name="longitude" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-86.9212" required /></Field>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={locate} loading={locating}>Use this device&apos;s location</Button>
          <Field label="Note" htmlFor="tp-note" hint="For example: at the quarry scale"><Input id="tp-note" name="note" maxLength={200} /></Field>
          <Button type="submit" loading={pending}>Record location</Button>
        </form>
      </Dialog>
    </>
  );
}

/** Record a driver's hours by hand: dispatch for anyone, or a driver for themselves (one driver, no choice). */
export function RecordHoursButton({ drivers, label = "Record hours" }: { drivers: Option[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const { pending, onSubmit, formError } = useAction(recordHours, () => setOpen(false));
  const single = drivers.length === 1;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{label}</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Record hours of service" description="Copy the clocks from the ELD or logbook. Hand-entered hours are shown with their time and never count as verified." size="sm">
        <form onSubmit={onSubmit} className="space-y-3" noValidate aria-label="Record hours">
          <FormError message={formError} />
          {single ? <input type="hidden" name="driver" value={drivers[0].id} /> : (
            <Field label="Driver" htmlFor="th-driver" required>
              <Select id="th-driver" name="driver" defaultValue="" required>
                <option value="" disabled>Choose a driver</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Duty status" htmlFor="th-duty" required>
            <Select id="th-duty" name="duty_status" defaultValue="on_duty" required>
              {(Object.keys(DUTY_LABEL) as DutyStatus[]).map((d) => <option key={d} value={d}>{DUTY_LABEL[d]}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Drive left" htmlFor="th-drive" hint="h:mm"><Input id="th-drive" name="drive" inputMode="numeric" placeholder="11:00" /></Field>
            <Field label="Shift left" htmlFor="th-shift" hint="h:mm"><Input id="th-shift" name="shift" inputMode="numeric" placeholder="14:00" /></Field>
            <Field label="Cycle left" htmlFor="th-cycle" hint="h:mm"><Input id="th-cycle" name="cycle" inputMode="numeric" placeholder="60:00" /></Field>
          </div>
          <Button type="submit" loading={pending}>Record hours</Button>
        </form>
      </Dialog>
    </>
  );
}

/** Settings → GPS and hours: source, how long data counts as current, and the feed key (shown once). */
export function TelematicsSettingsForm({ source, staleMinutes, keyHint, canEdit, endpoint }: { source: TelematicsSource; staleMinutes: number; keyHint: string; canEdit: boolean; endpoint: string }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useAction(saveTelematicsSettings);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const make = () => start(async () => {
    const r = await createFeedKey();
    if (!r.ok) return void toast.error(r.error);
    setNewKey(r.data.key);
    router.refresh();
  });
  const revoke = () => start(async () => {
    const r = await revokeFeedKey();
    if (!r.ok) return void toast.error(r.error);
    toast.success(r.message ?? "Revoked.");
    router.refresh();
  });
  return (
    <div className="max-w-2xl space-y-6">
      <form onSubmit={onSubmit} className="space-y-4" aria-label="GPS and hours">
        <FormError message={formError} />
        <fieldset className="space-y-2" disabled={!canEdit}>
          <legend className="mb-1 text-sm font-medium">Positions and hours come from</legend>
          {SOURCE_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-start gap-3 rounded-control border border-line p-3 has-[:checked]:border-strong has-[:checked]:bg-surface">
              <input type="radio" name="source" value={o.value} defaultChecked={o.value === source} className="mt-1 size-4 accent-brand" />
              <span><span className="block font-medium">{o.label}</span><span className="block text-sm text-muted">{o.description}</span></span>
            </label>
          ))}
        </fieldset>
        <Field label="Data counts as current for (minutes)" htmlFor="tl-stale" hint="Older positions and hours are marked stale and never verify a driver.">
          <Input id="tl-stale" name="stale_minutes" inputMode="numeric" defaultValue={staleMinutes} disabled={!canEdit} className="max-w-32" />
        </Field>
        {canEdit && <Button type="submit" loading={pending}>Save</Button>}
      </form>

      <section className="space-y-3 border-t border-line pt-5" aria-label="Provider feed key">
        <h3 className="text-sm font-semibold">Provider feed key</h3>
        <p className="text-sm text-muted">
          Your provider (or a connector such as Zapier) sends <code className="rounded bg-surface px-1">POST {endpoint}</code> with the header
          <code className="mx-1 rounded bg-surface px-1">Authorization: Bearer &lt;feed key&gt;</code> and a JSON body with <code className="rounded bg-surface px-1">positions</code> (truck unit number, latitude, longitude, time)
          and <code className="rounded bg-surface px-1">hours</code> (driver name, duty status, minutes left). Only the key&apos;s fingerprint is stored.
        </p>
        <p className="text-sm">{keyHint ? <>A key ending in <span className="font-mono font-medium">…{keyHint}</span> is active.</> : "No key yet."}</p>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={make} loading={busy}>{keyHint ? "Replace key" : "Create feed key"}</Button>
            {keyHint && <Button size="sm" variant="ghost" onClick={revoke} disabled={busy}>Revoke key</Button>}
          </div>
        )}
      </section>

      <Dialog open={newKey !== null} onOpenChange={(o) => !o && setNewKey(null)} title="Copy your feed key" description="This is the only time it is shown. Anyone with it can send positions and hours for your company. Any earlier key no longer works." size="sm">
        <div className="space-y-3">
          <Input readOnly value={newKey ?? ""} aria-label="Feed key" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(newKey ?? ""); toast.success("Copied."); }}>Copy</Button>
            <Button size="sm" variant="ghost" onClick={() => setNewKey(null)}>Done</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
