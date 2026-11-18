"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { PlaceInput } from "@/components/orders/place-input";
import { saveOrderStops } from "@/app/(app)/orders/stops-actions";
import { appointmentText, emptyStop, MAX_STOPS, STOP_KIND_LABELS, STOP_KINDS, stopAddress, stopProblems, stopsSummary, type OrderStop, type StopInput, type StopKind } from "@/lib/orders/stops";
import { canOfferSave, stopWindowWarning, type LoadWindow, type StopPlace } from "@/lib/orders/stop-checks";
import { cn } from "@/lib/cn";

/**
 * Stops on an order (MK2 slice 1): pickups and deliveries in order, each with its place, appointment and reference.
 * Read by everyone who sees the order; changed by people with orders.edit while the order is open.
 * WK3 (owner 2026-11-16/17): a stop outside the load's window is flagged in plain words (saving is still allowed);
 * the place name suggests the customer's job sites and the company's saved places, and a typed place can be saved for
 * next time by people who may change saved locations.
 */
export function OrderStops({ orderId, stops, canEdit, window: loadWindow = null, places = [], canSavePlaces = false }: {
  orderId: string;
  stops: OrderStop[];
  canEdit: boolean;
  /** The load's delivery window (the order's dates and daily times); null when the order has none. */
  window?: LoadWindow | null;
  /** Saved places to suggest while typing a stop's name. */
  places?: StopPlace[];
  /** Whether the person may save a typed place for next time (dispatch.edit or settings.manage). */
  canSavePlaces?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) return <StopsEditor orderId={orderId} initial={stops} loadWindow={loadWindow} places={places} canSavePlaces={canSavePlaces} onDone={() => setEditing(false)} />;
  return (
    <div>
      {stops.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted sm:px-6">
          No stops listed. Add them when a load has several pickups or deliveries, or appointment times at a shipper or receiver.
        </p>
      ) : (
        <ol className="divide-y divide-line" aria-label="Stops">
          {stops.map((s) => (
            <StopRow key={s.id} stop={s} warning={loadWindow ? stopWindowWarning(s, loadWindow) : null} />
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

/** "This stop is after the load's window ends at 2:00 PM." A warning, not an error: saving stays allowed. */
function WindowWarning({ message, id }: { message: string; id?: string }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-sm text-amber-800" role="status" data-testid="stop-window-warning">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

function StopRow({ stop, warning }: { stop: OrderStop; warning: string | null }) {
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
        {warning ? <WindowWarning message={warning} /> : null}
        {stop.notes ? <p className="whitespace-pre-line text-sm text-muted">{stop.notes}</p> : null}
      </div>
    </li>
  );
}

type EditStop = StopInput & { saveForNextTime?: boolean };

function StopsEditor({ orderId, initial, loadWindow, places, canSavePlaces, onDone }: { orderId: string; initial: OrderStop[]; loadWindow: LoadWindow | null; places: StopPlace[]; canSavePlaces: boolean; onDone: () => void }) {
  const router = useRouter();
  const [stops, setStops] = useState<EditStop[]>(() =>
    initial.length
      ? initial.map((s) => ({ id: s.id, kind: s.kind, name: s.name, address_line1: s.address_line1, city: s.city, state: s.state, postal_code: s.postal_code, appointment_date: s.appointment_date, window_start: s.window_start, window_end: s.window_end, reference: s.reference, notes: s.notes }))
      : [emptyStop("pickup"), emptyStop("delivery")],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const update = (i: number, patch: Partial<EditStop>) => setStops((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
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

  const save = (edited: EditStop[]) => {
    const list: StopInput[] = edited.map((s) => {
      const copy: EditStop = { ...s };
      delete copy.saveForNextTime;
      return copy;
    });
    const savePlaces = canSavePlaces ? edited.flatMap((s, i) => (s.saveForNextTime && canOfferSave(places, s) ? [i] : [])) : [];
    const problems = stopProblems(list);
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setError(null);
    start(async () => {
      const r = await saveOrderStops(orderId, list, { savePlaces });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Saved either way; a stop outside the load's window is said again where the person is looking.
      if (r.data?.warnings.length) toast.warning(r.message ?? "Saved.");
      else toast.success(r.message ?? "Saved.");
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
                    <PlaceInput
                      id={`${id}-name`}
                      value={s.name}
                      places={places}
                      onType={(name) => update(i, { name })}
                      onPick={(p) => update(i, { name: p.name.slice(0, 160), address_line1: p.address_line1.slice(0, 200), city: p.city.slice(0, 80), state: p.state.slice(0, 40), postal_code: p.postal_code.slice(0, 20), saveForNextTime: false })}
                    />
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
                {canSavePlaces && canOfferSave(places, s) && (
                  <Checkbox
                    label="Save this place for next time"
                    checked={Boolean(s.saveForNextTime)}
                    onChange={(e) => update(i, { saveForNextTime: e.target.checked })}
                  />
                )}
                {loadWindow && stopWindowWarning(s, loadWindow) && <WindowWarning message={stopWindowWarning(s, loadWindow)!} />}
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
