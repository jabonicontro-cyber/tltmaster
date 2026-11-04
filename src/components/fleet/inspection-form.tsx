"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { INSPECTION_ITEMS, KIND_LABEL, type InspectionKind } from "@/lib/inspections/items";
import { submitInspection } from "@/app/(app)/fleet/inspections/actions";
import { announceOutbox, enqueue, isNetworkError } from "@/lib/offline/store";

type Truck = { id: string; label: string; pending: InspectionKind[] };
type Mark = { ok: boolean | null; note: string };

/**
 * A pre-trip or post-trip inspection (B132): every item marked OK or Defect, each defect described. Defects open a
 * work order for the shop; a defect in a safety item (marked) takes the truck out of service. Never blocks dispatch.
 */
export function InspectionForm({ trucks: given, queue }: { trucks: Truck[]; queue?: { userId: string; day: string } }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Inspections saved on this phone without signal (B133) count as done here, so the same one is not entered twice.
  const [kept, setKept] = useState<string[]>([]);
  const trucks = given.map((t) => ({ ...t, pending: t.pending.filter((k) => !kept.includes(`${t.id}:${k}`)) }));
  const [savedOffline, setSavedOffline] = useState(false);
  const [truckId, setTruckId] = useState(given[0]?.id ?? "");
  const truck = trucks.find((t) => t.id === truckId);
  const [chosenKind, setKind] = useState<InspectionKind>(truck?.pending[0] ?? "pre_trip");
  // After a save (or a truck change) the chosen inspection may be done: move to the next one due for this truck.
  const kind: InspectionKind = !truck || truck.pending.includes(chosenKind) ? chosenKind : truck.pending[0] ?? chosenKind;
  const [odometer, setOdometer] = useState("");
  const [remarks, setRemarks] = useState("");
  const blank = () => Object.fromEntries(INSPECTION_ITEMS.map((i) => [i.key, { ok: null, note: "" } as Mark]));
  const [marks, setMarks] = useState<Record<string, Mark>>(blank);
  const mark = (key: string, m: Partial<Mark>) => setMarks((s) => ({ ...s, [key]: { ...s[key], ...m } }));
  const unchecked = INSPECTION_ITEMS.filter((i) => marks[i.key].ok === null).length;
  const safetyDefect = INSPECTION_ITEMS.some((i) => i.safety && marks[i.key].ok === false);

  const submit = () => start(async () => {
    setError(null);
    if (unchecked > 0) return setError(`Mark every item OK or Defect (${unchecked} left).`);
    setSavedOffline(false);
    const input = { truckId, kind, odometer, remarks, items: INSPECTION_ITEMS.map((i) => ({ key: i.key, ok: marks[i.key].ok === true, note: marks[i.key].note })) };
    const keep = () => {
      if (!queue) return false;
      const label = `${kind === "pre_trip" ? "Pre-trip" : "Post-trip"} inspection, ${truck?.label ?? "truck"}`;
      if (!enqueue({ id: crypto.randomUUID(), userId: queue.userId, kind: "inspection", label, payload: { ...input, inspectedOn: queue.day } })) return false;
      announceOutbox();
      setKept((k) => [...k, `${truckId}:${kind}`]);
      setMarks(blank());
      setOdometer("");
      setRemarks("");
      setSavedOffline(true);
      return true;
    };
    if (typeof navigator !== "undefined" && navigator.onLine === false && keep()) return;
    let r: Awaited<ReturnType<typeof submitInspection>>;
    try {
      r = await submitInspection(input);
    } catch (e) {
      if (isNetworkError(e) && keep()) return;
      return setError("Not sent — no connection to the office. Check your signal and try again.");
    }
    if (!r.ok) return setError(r.error);
    if (r.data.safety) toast.warning(r.message ?? "Saved."); else toast.success(r.message ?? "Saved.");
    setMarks(blank());
    setOdometer("");
    setRemarks("");
    router.refresh();
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-4" aria-label="Vehicle inspection">
      <FormError message={error} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {trucks.length > 1 && (
          <Field label="Truck" htmlFor="insp-truck">
            <Select id="insp-truck" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
              {trucks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Inspection" htmlFor="insp-kind">
          <Select id="insp-kind" value={kind} onChange={(e) => setKind(e.target.value as InspectionKind)}>
            {(["pre_trip", "post_trip"] as const).map((k) => <option key={k} value={k} disabled={truck ? !truck.pending.includes(k) : false}>{KIND_LABEL[k]}{truck && !truck.pending.includes(k) ? " (done)" : ""}</option>)}
          </Select>
        </Field>
        <Field label="Odometer" htmlFor="insp-odo" hint="Optional"><Input id="insp-odo" inputMode="numeric" value={odometer} onChange={(e) => setOdometer(e.target.value)} /></Field>
      </div>

      <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Inspection items">
        {INSPECTION_ITEMS.map((i) => {
          const m = marks[i.key];
          return (
            <li key={i.key} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 text-sm font-semibold text-ink">
                  {i.label}
                  {i.safety && <span className="ml-2 text-xs font-medium text-muted">Safety</span>}
                </span>
                <div role="group" aria-label={i.label} className="flex gap-1 rounded-full bg-ink/[0.05] p-1">
                  <button type="button" aria-pressed={m.ok === true} onClick={() => mark(i.key, { ok: true, note: "" })}
                    className={cn("h-12 min-w-20 rounded-full px-4 text-base font-semibold", m.ok === true ? "bg-card text-ink shadow-xs" : "text-muted")}>OK</button>
                  <button type="button" aria-pressed={m.ok === false} onClick={() => mark(i.key, { ok: false })}
                    className={cn("h-12 min-w-20 rounded-full px-4 text-base font-semibold", m.ok === false ? "bg-critical text-white" : "text-muted")}>Defect</button>
                </div>
              </div>
              {m.ok === false && (
                <Input aria-label={`What is wrong with ${i.label.toLowerCase()}`} placeholder="What is wrong?" className="mt-2" maxLength={300} value={m.note} onChange={(e) => mark(i.key, { note: e.target.value })} />
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" className="text-sm font-semibold text-brand-fg hover:underline" onClick={() => setMarks((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.ok === null ? { ok: true, note: "" } : v])))}>
        Mark the rest OK
      </button>
      <Field label="Remarks" htmlFor="insp-remarks" hint="Optional"><Textarea id="insp-remarks" rows={2} maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
      {savedOffline && <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950 ring-1 ring-amber-200" role="status">Saved on this phone — not sent yet. It sends by itself when you have signal. Tell dispatch now about any safety defect.</p>}
      {safetyDefect && <p className="text-sm font-semibold text-critical" role="status">A safety defect takes this truck out of service until the shop clears it.</p>}
      <Button type="submit" loading={busy} disabled={!truckId || (truck ? !truck.pending.includes(kind) : false)}>Save inspection</Button>
    </form>
  );
}
