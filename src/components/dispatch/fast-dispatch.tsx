"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { combinationCheck, type ActiveAssignment, type Crew, type CrewProposal } from "@/lib/dispatch/board";
import { eligibilityMessage } from "@/lib/fleet/eligibility";
import { formatTime } from "@/lib/orders/schedule";
import type { DispatchDay, OrderLoadRow } from "@/server/data/dispatch";
import type { OrderListRow } from "@/server/data/types";
import { assignLoad } from "@/app/(app)/dispatch/actions";

// Faster dispatching (master plan B85): assign several loads to one crew, copy the previous crew, keyboard shortcuts.
// Nothing here assigns on its own: a dispatcher approves each batch, and every load still goes through assign_load
// (eligibility, overlaps, shifts and maintenance are checked there; the board pre-checks the same rules first).

export interface FastLookup {
  orders: Map<string, OrderListRow>;
  trucks: Map<string, DispatchDay["trucks"][number]>;
  trailers: Map<string, DispatchDay["trailers"][number]>;
  drivers: Map<string, DispatchDay["drivers"][number]>;
}

export type BatchItem = Crew & { load: OrderLoadRow };
export type BatchResult = { loadId: string; ok: boolean; message: string };

const loadLabel = (l: OrderLoadRow, lk: FastLookup) => `${lk.orders.get(l.order_id)?.order_number ?? "Order"} · load ${l.load_number} · ${formatTime(l.start_time)}`;
export const crewText = (c: Crew, lk: FastLookup) =>
  [lk.trucks.get(c.truck_id)?.unit_number ? `Truck ${lk.trucks.get(c.truck_id)!.unit_number}` : "Truck ?", c.trailer_id ? `trailer ${lk.trailers.get(c.trailer_id)?.unit_number ?? "?"}` : null, lk.drivers.get(c.driver_id)?.display_name ?? "driver ?"].filter(Boolean).join(" · ");

/**
 * The board's own check for each item of a batch, in order: eligibility of the crew and overlaps with the day's
 * assignments and with earlier items of the same batch (two loads at the same time cannot share a truck).
 */
export function precheckBatch(items: BatchItem[], active: ActiveAssignment[], lk: FastLookup): string[][] {
  const planned: ActiveAssignment[] = [...active];
  return items.map((it, i) => {
    const check = combinationCheck(
      { truck: lk.trucks.get(it.truck_id) ?? null, trailer: it.trailer_id ? lk.trailers.get(it.trailer_id) ?? null : null, driver: lk.drivers.get(it.driver_id) ?? null },
      { starts_at: it.load.starts_at, ends_at: it.load.ends_at },
      planned,
      it.load.load_date,
    );
    const reasons = [...check.blockers.map(eligibilityMessage), ...check.conflicts.map((c) => `The ${c.kind} is already booked at that time.`)];
    if (!reasons.length) planned.push({ id: `batch-${i}`, load_id: it.load.id, truck_id: it.truck_id, trailer_id: it.trailer_id, driver_id: it.driver_id, status: "active", starts_at: it.load.starts_at, ends_at: it.load.ends_at });
    return reasons;
  });
}

/** One assign_load per item, one after the other, so each sees the previous ones; every outcome is reported. */
export async function runBatch(items: BatchItem[], onProgress?: (done: number) => void): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (const it of items) {
    const r = await assignLoad({ loadId: it.load.id, orderId: it.load.order_id, truckId: it.truck_id, trailerId: it.trailer_id, driverId: it.driver_id, note: "", replaceAssignmentId: null }).catch(() => null);
    results.push(
      !r
        ? { loadId: it.load.id, ok: false, message: "Could not be saved. Check the connection and try again." }
        : r.ok
          ? { loadId: it.load.id, ok: true, message: "Assigned" }
          : { loadId: it.load.id, ok: false, message: r.fieldErrors?.offShift ? `${r.error} Assign this load on its own to record a reason.` : r.error },
    );
    onProgress?.(results.length);
  }
  return results;
}

function Results({ results, items, lk }: { results: BatchResult[]; items: BatchItem[]; lk: FastLookup }) {
  const byLoad = new Map(items.map((i) => [i.load.id, i.load]));
  return (
    <ul className="divide-y divide-line rounded-2xl border border-line/70" aria-label="Results">
      {results.map((r) => (
        <li key={r.loadId} className="flex items-start gap-2 px-3 py-2 text-sm">
          {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-700" aria-hidden /> : <XCircle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />}
          <span><span className="font-semibold">{loadLabel(byLoad.get(r.loadId)!, lk)}</span> — {r.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Assign one crew to every selected load. */
export function BulkAssignDialog({ loads, active, lk, onClose, onDone }: { loads: OrderLoadRow[]; active: ActiveAssignment[]; lk: FastLookup; onClose: () => void; onDone: () => void }) {
  const [truckId, setTruckId] = useState("");
  const [trailerId, setTrailerId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [running, setRunning] = useState<number | null>(null);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const sorted = useMemo(() => [...loads].sort((a, b) => a.starts_at.localeCompare(b.starts_at)), [loads]);
  const items: BatchItem[] = truckId && driverId ? sorted.map((load) => ({ load, truck_id: truckId, trailer_id: trailerId || null, driver_id: driverId })) : [];
  const checks = items.length ? precheckBatch(items, active, lk) : [];
  const blocked = checks.filter((c) => c.length).length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Assign ${loads.length} loads`} description="One crew for all selected loads, in time order. Each load is checked and saved on its own; loads that cannot take this crew are left open.">
      {results ? (
        <div className="space-y-4">
          <Results results={results} items={items} lk={lk} />
          <div className="flex justify-end"><Button onClick={onDone}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Truck" htmlFor="bulk-truck">
              <Select id="bulk-truck" value={truckId} onChange={(e) => setTruckId(e.target.value)}>
                <option value="">Choose…</option>
                {[...lk.trucks.values()].map((t) => <option key={t.id} value={t.id} disabled={t.service_status === "out_of_service"}>{t.unit_number}{t.service_status === "out_of_service" ? " (out of service)" : ""}</option>)}
              </Select>
            </Field>
            <Field label="Trailer" htmlFor="bulk-trailer">
              <Select id="bulk-trailer" value={trailerId} onChange={(e) => setTrailerId(e.target.value)}>
                <option value="">None</option>
                {[...lk.trailers.values()].map((t) => <option key={t.id} value={t.id}>{t.unit_number}</option>)}
              </Select>
            </Field>
            <Field label="Driver" htmlFor="bulk-driver">
              <Select id="bulk-driver" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                <option value="">Choose…</option>
                {[...lk.drivers.values()].map((d) => <option key={d.id} value={d.id}>{d.display_name}</option>)}
              </Select>
            </Field>
          </div>
          <ul className="divide-y divide-line rounded-2xl border border-line/70" aria-label="Selected loads">
            {sorted.map((l, i) => (
              <li key={l.id} className="px-3 py-2 text-sm">
                <span className="font-semibold">{loadLabel(l, lk)}</span>
                {checks[i]?.length ? <span className="block text-xs text-critical">{checks[i].join(" ")}</span> : items.length ? <span className="block text-xs text-green-800">Ready</span> : null}
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={running !== null}>Cancel</Button>
            <Button
              disabled={!items.length || blocked === items.length || running !== null}
              loading={running !== null}
              onClick={async () => {
                const ready = items.filter((_, i) => !checks[i].length);
                const skipped: BatchResult[] = items.flatMap((it, i) => (checks[i].length ? [{ loadId: it.load.id, ok: false, message: `Left open: ${checks[i].join(" ")}` }] : []));
                setRunning(0);
                setResults([...(await runBatch(ready, setRunning)), ...skipped]);
                setRunning(null);
              }}
            >
              {running !== null ? `Assigning ${running} of ${items.length - blocked}…` : `Assign ${items.length ? items.length - blocked : loads.length} loads`}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** "Copy the previous crew": review the proposals, untick any, then assign. */
export function CopyCrewsDialog({ proposals, loads, active, lk, onClose, onDone }: { proposals: CrewProposal[]; loads: Map<string, OrderLoadRow>; active: ActiveAssignment[]; lk: FastLookup; onClose: () => void; onDone: () => void }) {
  const items: BatchItem[] = proposals.filter((p) => loads.has(p.load_id)).map((p) => ({ load: loads.get(p.load_id)!, truck_id: p.truck_id, trailer_id: p.trailer_id, driver_id: p.driver_id }));
  const checks = precheckBatch(items, active, lk);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(items.filter((_, i) => !checks[i].length).map((i) => i.load.id)));
  const [running, setRunning] = useState<number | null>(null);
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const from = proposals[0]?.from_date;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Copy the previous crew" description={`For each open load, the crew that worked the same order on its last day before this one${from ? ` (for example ${formatDate(from)})` : ""}. Untick any you do not want; each load is checked and saved on its own.`}>
      {results ? (
        <div className="space-y-4">
          <Results results={results} items={items} lk={lk} />
          <div className="flex justify-end"><Button onClick={onDone}>Done</Button></div>
        </div>
      ) : (
        <div className="space-y-4">
          <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-2xl border border-line/70" aria-label="Proposed crews">
            {items.map((it, i) => (
              <li key={it.load.id} className={cn("flex items-start gap-3 px-3 py-2 text-sm", checks[i].length && "bg-surface/60")}>
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-[var(--color-strong)]"
                  aria-label={`Copy crew to ${loadLabel(it.load, lk)}`}
                  checked={chosen.has(it.load.id)}
                  disabled={checks[i].length > 0}
                  onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(it.load.id); else n.delete(it.load.id); return n; })}
                />
                <span className="min-w-0">
                  <span className="block font-semibold">{loadLabel(it.load, lk)}</span>
                  <span className="block text-muted">{crewText(it, lk)} · from {formatDate(proposals[i].from_date)}</span>
                  {checks[i].length > 0 && <span className="block text-xs text-critical">{checks[i].join(" ")}</span>}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={running !== null}>Cancel</Button>
            <Button
              disabled={!chosen.size || running !== null}
              loading={running !== null}
              onClick={async () => {
                setRunning(0);
                setResults(await runBatch(items.filter((it) => chosen.has(it.load.id)), setRunning));
                setRunning(null);
              }}
            >
              {running !== null ? `Assigning ${running} of ${chosen.size}…` : `Assign ${chosen.size} ${chosen.size === 1 ? "load" : "loads"}`}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export const SHORTCUTS: Array<[string, string]> = [
  ["←  →", "Previous or next day"],
  ["T", "Today"],
  ["C", "Copy the previous crew"],
  ["A", "Assign the selected loads"],
  ["Esc", "Clear the selection"],
  ["?", "Show these shortcuts"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Keyboard shortcuts" description="On the dispatch board, when you are not typing in a field. Drag a driver or truck onto a load to assign it.">
      <dl className="divide-y divide-line">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between py-2 text-sm">
            <dt className="text-muted">{v}</dt>
            <dd><kbd className="rounded-md border border-line bg-surface px-2 py-0.5 font-sans text-xs font-semibold">{k}</kbd></dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
