"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Textarea } from "@/components/ui/form";
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
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [k]: e.target.value }));

  async function submit() {
    setPending(true);
    setError(null);
    setFieldErrors({});
    const r = await planTruckDay({ orderId: order.id, ...values });
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
          <Field label="From" htmlFor="td-start" required error={fieldErrors.startTime}>
            <Input id="td-start" type="time" value={values.startTime} onChange={set("startTime")} />
          </Field>
          <Field label="Until (planned)" htmlFor="td-end" required error={fieldErrors.endTime}>
            <Input id="td-end" type="time" value={values.endTime} onChange={set("endTime")} />
          </Field>
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
