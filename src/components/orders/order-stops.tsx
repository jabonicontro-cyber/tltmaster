"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { saveOrderStops } from "@/app/(app)/orders/stops-actions";
import { appointmentText, emptyStop, MAX_STOPS, STOP_KIND_LABELS, STOP_KINDS, stopAddress, stopProblems, stopsSummary, type OrderStop, type StopInput, type StopKind } from "@/lib/orders/stops";
import { cn } from "@/lib/cn";

/**
 * Stops on an order (MK2 slice 1): pickups and deliveries in order, each with its place, appointment and reference.
 * Read by everyone who sees the order; changed by people with orders.edit while the order is open.
 */
export function OrderStops({ orderId, stops, canEdit }: { orderId: string; stops: OrderStop[]; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <StopsEditor orderId={orderId} initial={stops} onDone={() => setEditing(false)} />;
  return (
    <div>
      {stops.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted sm:px-6">
          No stops listed. Add them when a load has several pickups or deliveries, or appointment times at a shipper or receiver.
        </p>
      ) : (
        <ol className="divide-y divide-line" aria-label="Stops">
          {stops.map((s) => (
            <StopRow key={s.id} stop={s} />
          ))}
        </ol>
      )}
      {canEdit && (
        <div className="border-t border-line px-5 py-3 sm:px-6">
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            {stops.length ? "Edit stops" : "Add stops"}
          </Button>
        </div>
      )}
    </div>
  );
}

function StopRow({ stop }: { stop: OrderStop }) {
  const address = stopAddress(stop);
  const when = appointmentText(stop);
  return (
    <li className="flex gap-3 px-5 py-3 sm:px-6">
      <span
        className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold tabular", stop.kind === "pickup" ? "bg-strong text-white" : "bg-ink/[0.08] text-ink")}
        aria-hidden
      >
        {stop.seq}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone={stop.kind === "pickup" ? "blue" : "gray"}>{STOP_KIND_LABELS[stop.kind]}</Badge>
          <strong className="text-ink">{stop.name}</strong>
          {stop.reference ? <span className="text-sm text-muted">Ref {stop.reference}</span> : null}
        </p>
        {address ? <p className="text-sm text-muted">{address}</p> : null}
        <p className="text-sm">{when ? <span className="tabular">{when}</span> : <span className="text-muted">No appointment</span>}</p>
        {stop.notes ? <p className="whitespace-pre-line text-sm text-muted">{stop.notes}</p> : null}
      </div>
    </li>
  );
}

function StopsEditor({ orderId, initial, onDone }: { orderId: string; initial: OrderStop[]; onDone: () => void }) {
  const router = useRouter();
  const [stops, setStops] = useState<StopInput[]>(() =>
    initial.length
      ? initial.map((s) => ({ id: s.id, kind: s.kind, name: s.name, address_line1: s.address_line1, city: s.city, state: s.state, postal_code: s.postal_code, appointment_date: s.appointment_date, window_start: s.window_start, window_end: s.window_end, reference: s.reference, notes: s.notes }))
      : [emptyStop("pickup"), emptyStop("delivery")],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const update = (i: number, patch: Partial<StopInput>) => setStops((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: -1 | 1) =>
    setStops((all) => {
      const next = [...all];
      const [s] = next.splice(i, 1);
      next.splice(i + by, 0, s);
      return next;
    });
  const remove = (i: number) => setStops((all) => all.filter((_, j) => j !== i));
  const add = (kind: StopKind) =>
    setStops((all) => {
      if (kind === "delivery") return [...all, emptyStop(kind)];
      // A new pickup goes after the last pickup, so the list keeps loading before delivering.
      const lastPickup = all.map((s) => s.kind).lastIndexOf("pickup");
      const next = [...all];
      next.splice(lastPickup + 1, 0, emptyStop(kind));
      return next;
    });

  const save = (list: StopInput[]) => {
    const problems = stopProblems(list);
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setError(null);
    start(async () => {
      const r = await saveOrderStops(orderId, list);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(r.message ?? "Saved.");
      onDone();
      router.refresh();
    });
  };

  return (
    <form
      className="space-y-4 px-5 py-4 sm:px-6"
      noValidate
      data-guard-unsaved
      aria-label="Edit stops"
      onSubmit={(e) => {
        e.preventDefault();
        save(stops);
      }}
    >
      <p className="text-sm text-muted">
        In the order the truck makes them: the first stop is a pickup and the last a delivery. {stops.length ? stopsSummary(stops) + "." : ""}
      </p>
      <FormError message={error} />
      <ol className="space-y-3">
        {stops.map((s, i) => {
          const id = `stop-${i}`;
          return (
            <li key={s.id ?? `new-${i}`} className="rounded-xl border border-line p-3 sm:p-4">
              <fieldset className="space-y-3">
                <legend className="flex w-full flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-ink">Stop {i + 1}</span>
                  <span className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move stop ${i + 1} up`} icon={<ArrowUp className="size-4" aria-hidden />} />
                    <Button variant="ghost" size="sm" onClick={() => move(i, 1)} disabled={i === stops.length - 1} aria-label={`Move stop ${i + 1} down`} icon={<ArrowDown className="size-4" aria-hidden />} />
                    <Button variant="ghost" size="sm" onClick={() => remove(i)} aria-label={`Remove stop ${i + 1}`} icon={<Trash2 className="size-4" aria-hidden />} />
                  </span>
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
                  <Field label="Kind" htmlFor={`${id}-kind`}>
                    <Select id={`${id}-kind`} value={s.kind} onChange={(e) => update(i, { kind: e.target.value as StopKind })}>
                      {STOP_KINDS.map((k) => (
                        <option key={k} value={k}>{STOP_KIND_LABELS[k]}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={s.kind === "pickup" ? "Shipper or place" : "Receiver or place"} htmlFor={`${id}-name`} required>
                    <Input id={`${id}-name`} value={s.name} maxLength={160} onChange={(e) => update(i, { name: e.target.value })} autoComplete="off" />
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem_5rem_7rem]">
                  <Field label="Street address" htmlFor={`${id}-line1`}>
                    <Input id={`${id}-line1`} value={s.address_line1} maxLength={200} onChange={(e) => update(i, { address_line1: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label="City" htmlFor={`${id}-city`}>
                    <Input id={`${id}-city`} value={s.city} maxLength={80} onChange={(e) => update(i, { city: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label="State" htmlFor={`${id}-state`}>
                    <Input id={`${id}-state`} value={s.state} maxLength={40} onChange={(e) => update(i, { state: e.target.value })} autoComplete="off" />
                  </Field>
                  <Field label="ZIP" htmlFor={`${id}-zip`}>
                    <Input id={`${id}-zip`} value={s.postal_code} maxLength={20} inputMode="numeric" onChange={(e) => update(i, { postal_code: e.target.value })} autoComplete="off" />
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[11rem_9.5rem_9.5rem_1fr]">
                  <Field label="Appointment date" htmlFor={`${id}-date`}>
                    <DateInput id={`${id}-date`} value={s.appointment_date} onChange={(e) => update(i, { appointment_date: e.target.value })} />
                  </Field>
                  <Field label="Window from" htmlFor={`${id}-from`}>
                    <Input id={`${id}-from`} type="time" value={s.window_start} onChange={(e) => update(i, { window_start: e.target.value })} />
                  </Field>
                  <Field label="Window to" htmlFor={`${id}-to`}>
                    <Input id={`${id}-to`} type="time" value={s.window_end} onChange={(e) => update(i, { window_end: e.target.value })} />
                  </Field>
                  <Field label="Reference" htmlFor={`${id}-ref`} hint="Pickup number, PO or BOL">
                    <Input id={`${id}-ref`} value={s.reference} maxLength={80} onChange={(e) => update(i, { reference: e.target.value })} autoComplete="off" />
                  </Field>
                </div>
                <Field label="Notes for the driver" htmlFor={`${id}-notes`}>
                  <Textarea id={`${id}-notes`} value={s.notes} maxLength={500} rows={2} onChange={(e) => update(i, { notes: e.target.value })} />
                </Field>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => add("pickup")} disabled={stops.length >= MAX_STOPS} icon={<Plus className="size-4" aria-hidden />}>Add pickup</Button>
        <Button variant="secondary" size="sm" onClick={() => add("delivery")} disabled={stops.length >= MAX_STOPS} icon={<Plus className="size-4" aria-hidden />}>Add delivery</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button type="submit" loading={pending}>Save stops</Button>
        <Button variant="ghost" onClick={onDone} disabled={pending}>Cancel</Button>
        {initial.length > 0 && (
          <Button variant="danger" className="ml-auto" onClick={() => save([])} disabled={pending}>Remove all stops</Button>
        )}
      </div>
    </form>
  );
}
