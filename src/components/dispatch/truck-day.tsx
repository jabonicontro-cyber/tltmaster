"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input, Textarea } from "@/components/ui/form";
import { applyTruckHours, planTruckDay, releaseTruck } from "@/app/(app)/dispatch/truck-day-actions";

// Truck-day jobs (UX11): plan N trucks for a day, and release one truck (dispatch or its own driver; the database
// decides who may).

export function TruckDayDialog({ order, date, onClose, onSaved }: {
  order: { id: string; order_number: string; scheduled_start: string | null; scheduled_end: string | null; window_start: string | null; window_end: string | null };
  date: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : "");
  const [values, setValues] = useState({ date, trucks: "3", startTime: hhmm(order.window_start) || "06:30", endTime: hhmm(order.window_end) || "17:00", note: "" });
  // Different start times per truck (UX11): folded away until wanted; each truck starts at the shared time until changed.
  const [perTruck, setPerTruck] = useState(false);
  const [starts, setStarts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));
  const count = Math.min(50, Math.max(0, Math.trunc(Number(values.trucks)) || 0));
  const startFor = (i: number) => starts[i] ?? values.startTime;
  const setStart = (i: number, t: string) => setStarts(() => Array.from({ length: count }, (_, j) => (j === i ? t : startFor(j))));
  const startsError = fieldErrors.startTimes ?? Object.entries(fieldErrors).find(([k]) => k.startsWith("startTimes."))?.[1];

  async function submit() {
    setPending(true);
    setError(null);
    setFieldErrors({});
    // With different start times, the earliest one is the day's start (the shared field is hidden).
    const startTimes = perTruck ? Array.from({ length: count }, (_, i) => startFor(i)) : undefined;
    const startTime = startTimes?.length ? [...startTimes].sort()[0] : values.startTime;
    const r = await planTruckDay({ orderId: order.id, ...values, startTime, startTimes });
    setPending(false);
    if (!r.ok) {
      setError(r.error);
      setFieldErrors(r.fieldErrors ?? {});
      return;
    }
    onSaved(r.message ?? "Trucks added.");
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Trucks for the day on ${order.order_number}`}
      description="Each truck gets its own slot to assign. Drivers enter a ticket for every trip; the truck works until it is released."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button onClick={submit} loading={pending}>Add trucks</Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormError message={error} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Date" htmlFor="td-date" required error={fieldErrors.date} className="col-span-2 sm:col-span-1">
            <DateInput id="td-date" value={values.date} min={order.scheduled_start ?? undefined} max={order.scheduled_end ?? order.scheduled_start ?? undefined} onChange={set("date")} />
          </Field>
          <Field label="Trucks" htmlFor="td-trucks" required error={fieldErrors.trucks}>
            <Input id="td-trucks" type="number" min={1} max={50} inputMode="numeric" value={values.trucks} onChange={set("trucks")} className="text-right tabular" />
          </Field>
          {!perTruck && (
            <Field label="From" htmlFor="td-start" required error={fieldErrors.startTime}>
              <Input id="td-start" type="time" value={values.startTime} onChange={set("startTime")} />
            </Field>
          )}
          <Field label="Until (planned)" htmlFor="td-end" required error={fieldErrors.endTime}>
            <Input id="td-end" type="time" value={values.endTime} onChange={set("endTime")} />
          </Field>
        </div>
        <div className="space-y-3">
          <Checkbox
            id="td-per-truck"
            label="Different start times"
            checked={perTruck}
            onChange={(e) => {
              setPerTruck(e.target.checked);
              setStarts(Array.from({ length: count }, () => values.startTime));
            }}
          />
          {perTruck && (
            count > 0 ? (
              <fieldset className="space-y-2" aria-describedby={startsError ? "td-starts-error" : undefined}>
                <legend className="text-sm text-muted">Each truck starts at its own time and works until the planned end.</legend>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {Array.from({ length: count }, (_, i) => (
                    <li key={i}>
                      <label htmlFor={`td-start-${i}`} className="mb-1 block text-xs font-medium text-muted">Truck {i + 1} starts</label>
                      <Input id={`td-start-${i}`} type="time" value={startFor(i)} onChange={(e) => setStart(i, e.target.value)} />
                    </li>
                  ))}
                </ul>
                {startsError && <p id="td-starts-error" className="text-sm text-critical">{startsError}</p>}
              </fieldset>
            ) : (
              <p className="text-sm text-muted">Enter how many trucks first.</p>
            )
          )}
        </div>
        <Field label="Notes for the drivers" htmlFor="td-note" error={fieldErrors.note}>
          <Textarea id="td-note" rows={2} maxLength={1000} value={values.note} onChange={set("note")} />
        </Field>
      </div>
    </Dialog>
  );
}

export function ReleaseTruckButton({ loadId, orderId, label, size = "sm", variant = "secondary" }: { loadId: string; orderId?: string; label: string; size?: "sm" | "md" | "lg"; variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  async function release(): Promise<string | void> {
    const r = await releaseTruck({ loadId, orderId });
    if (!r.ok) return r.error;
    toast.success(r.message ?? "Truck released.");
    router.refresh();
  }
  return (
    <>
      <Button size={size} variant={variant} icon={<CircleCheck className="size-4" />} onClick={() => setOpen(true)}>{label}</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Release this truck?"
        description="Its day on this job ends now. The time is recorded for billing, and the truck and driver become free for a later job today."
        confirmLabel="Release"
        onConfirm={release}
      />
    </>
  );
}

/** "Released 2:14 PM by the driver", in the company's time zone. */
export function releasedText(at: string, source: string | null | undefined, timeZone?: string): string {
  const who = source === "driver" ? "by the driver" : source === "site" ? "by the site contact" : source === "dispatch" ? "by dispatch" : "";
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(at));
  return `Released ${time}${who ? ` ${who}` : ""}`;
}

/** Billing: add the reviewed truck-hours to the order as one line (a person approves; never twice per truck). */
export function AddTruckHoursButton({ orderId, summary }: { orderId: string; summary: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  async function add(): Promise<string | void> {
    const r = await applyTruckHours({ orderId });
    if (!r.ok) return r.error;
    toast.success(r.message ?? "Truck hours added.");
    router.refresh();
  }
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Add to order</Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Add these truck-hours to the order?"
        description={`${summary} One hourly line is added to the order and goes out with the invoice. Trucks already added are never added twice.`}
        confirmLabel="Add to order"
        onConfirm={add}
      />
    </>
  );
}
