"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { JURISDICTIONS } from "@/lib/fuel/ifta";
import { recordFuel, recordTripSheet, voidFuelEntry } from "@/app/(app)/fleet/fuel/actions";

type Truck = { id: string; label: string };

function StateSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="max-w-28">
      <option value="">State…</option>
      {JURISDICTIONS.map((j) => <option key={j} value={j}>{j}</option>)}
    </Select>
  );
}

/** Fuel bought for a truck (B130): the state, gallons and total from the receipt. */
export function FuelForm({ trucks, today, homeState, compact = false }: { trucks: Truck[]; today: string; homeState: string; compact?: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [v, setV] = useState({ truckId: trucks[0]?.id ?? "", day: today, jurisdiction: homeState, gallons: "", total: "", odometer: "", vendor: "", receipt: "" });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const submit = () => start(async () => {
    setError(null);
    const r = await recordFuel(v);
    if (!r.ok) return setError(r.error);
    toast.success(r.message ?? "Saved.");
    setV((s) => ({ ...s, gallons: "", total: "", odometer: "", vendor: "", receipt: "" }));
    router.refresh();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3" aria-label="Record fuel">
      <FormError message={error} />
      <div className={compact ? "grid grid-cols-2 gap-3" : "grid gap-3 sm:grid-cols-3"}>
        {trucks.length > 1 && (
          <Field label="Truck" htmlFor="fuel-truck"><Select id="fuel-truck" value={v.truckId} onChange={set("truckId")}>{trucks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
        )}
        <Field label="Day" htmlFor="fuel-day"><DateInput id="fuel-day" value={v.day} max={today} onChange={set("day")} /></Field>
        <Field label="State" htmlFor="fuel-state"><StateSelect id="fuel-state" value={v.jurisdiction} onChange={(x) => setV((s) => ({ ...s, jurisdiction: x }))} /></Field>
        <Field label="Gallons" htmlFor="fuel-gallons"><Input id="fuel-gallons" inputMode="decimal" value={v.gallons} onChange={set("gallons")} required /></Field>
        <Field label="Total ($)" htmlFor="fuel-total"><Input id="fuel-total" inputMode="decimal" value={v.total} onChange={set("total")} required /></Field>
        <Field label="Odometer" htmlFor="fuel-odo" hint="Optional"><Input id="fuel-odo" inputMode="numeric" value={v.odometer} onChange={set("odometer")} /></Field>
        {!compact && <Field label="Station" htmlFor="fuel-vendor" hint="Optional"><Input id="fuel-vendor" value={v.vendor} maxLength={120} onChange={set("vendor")} /></Field>}
        <Field label="Receipt #" htmlFor="fuel-receipt" hint="Optional"><Input id="fuel-receipt" value={v.receipt} maxLength={80} onChange={set("receipt")} /></Field>
      </div>
      <Button type="submit" loading={busy} disabled={!v.truckId}>Save fuel</Button>
    </form>
  );
}

/** A day's trip sheet (B130): odometer at the start and end and the miles in each state, which must add up. */
export function TripSheetForm({ trucks, today, homeState }: { trucks: Truck[]; today: string; homeState: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [truckId, setTruckId] = useState(trucks[0]?.id ?? "");
  const [day, setDay] = useState(today);
  const [odo, setOdo] = useState({ start: "", end: "" });
  const [legs, setLegs] = useState([{ jurisdiction: homeState, miles: "" }]);
  const driven = Number(odo.end) - Number(odo.start);
  const oneState = legs.length === 1;
  const sum = legs.reduce((n, l) => n + (Number(l.miles) || 0), 0);
  const submit = () => start(async () => {
    setError(null);
    // One state: all the day's miles are in it.
    const sent = oneState && Number.isFinite(driven) && driven >= 0 ? [{ jurisdiction: legs[0].jurisdiction, miles: String(driven) }] : legs;
    const r = await recordTripSheet({ truckId, day, start: odo.start, end: odo.end, legs: sent });
    if (!r.ok) return setError(r.error);
    toast.success(r.message ?? "Saved.");
    setOdo({ start: "", end: "" });
    setLegs([{ jurisdiction: homeState, miles: "" }]);
    router.refresh();
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-3" aria-label="Trip sheet">
      <FormError message={error} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {trucks.length > 1 && (
          <Field label="Truck" htmlFor="trip-truck"><Select id="trip-truck" value={truckId} onChange={(e) => setTruckId(e.target.value)}>{trucks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select></Field>
        )}
        <Field label="Day" htmlFor="trip-day"><DateInput id="trip-day" value={day} max={today} onChange={(e) => setDay(e.target.value)} /></Field>
        <Field label="Odometer at start" htmlFor="trip-start"><Input id="trip-start" inputMode="numeric" value={odo.start} onChange={(e) => setOdo((o) => ({ ...o, start: e.target.value }))} required /></Field>
        <Field label="Odometer at end" htmlFor="trip-end"><Input id="trip-end" inputMode="numeric" value={odo.end} onChange={(e) => setOdo((o) => ({ ...o, end: e.target.value }))} required /></Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">{oneState ? "State driven in" : "Miles in each state"}</legend>
        {legs.map((l, i) => (
          <div key={i} className="flex items-end gap-2">
            <StateSelect id={`trip-state-${i}`} value={l.jurisdiction} onChange={(x) => setLegs((ls) => ls.map((y, k) => (k === i ? { ...y, jurisdiction: x } : y)))} />
            {!oneState && (
              <Input aria-label={`Miles in ${l.jurisdiction || "state"} ${i + 1}`} inputMode="numeric" value={l.miles} onChange={(e) => setLegs((ls) => ls.map((y, k) => (k === i ? { ...y, miles: e.target.value } : y)))} className="max-w-28" placeholder="Miles" />
            )}
            {legs.length > 1 && (
              <Button type="button" variant="ghost" size="sm" aria-label="Remove state" onClick={() => setLegs((ls) => ls.filter((_, k) => k !== i))}><X className="size-4" /></Button>
            )}
          </div>
        ))}
        <Button type="button" variant="ghost" size="sm" icon={<Plus className="size-4" />} onClick={() => setLegs((ls) => [...ls, { jurisdiction: "", miles: "" }])}>Crossed into another state</Button>
        <p className="text-xs text-muted tabular">
          {Number.isFinite(driven) && odo.start && odo.end ? `${driven} miles driven` : "Miles come from the odometer."}{!oneState && odo.start && odo.end ? ` · ${sum} entered by state` : ""}
        </p>
      </fieldset>
      <Button type="submit" loading={busy} disabled={!truckId}>Save trip sheet</Button>
    </form>
  );
}

export function VoidFuelButton({ kind, id }: { kind: "purchase" | "trip_sheet"; id: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      loading={busy}
      onClick={() => {
        const reason = window.prompt("Why is this entry wrong? (kept with the record)");
        if (!reason?.trim()) return;
        start(async () => {
          const r = await voidFuelEntry(kind, id, reason);
          if (!r.ok) return void toast.error(r.error);
          toast.success("Voided.");
          router.refresh();
        });
      }}
    >
      Void
    </Button>
  );
}
