"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { approvePlanAssignments, type ApprovalOutcome } from "@/app/(app)/dispatch/plan/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlanExplanation, type PlanAiState } from "@/components/dispatch/plan-explanation";
import type { SmartLoad } from "@/lib/dispatch/smart";
import type { Optimization, Plan } from "@/lib/optimization/plan";

const time = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

function Metrics({ plan }: { plan: Plan }) {
  const m = plan.metrics;
  const rows: Array<[string, string]> = [
    ["Loads covered", `${m.covered} of ${m.loads}`],
    ["Urgent covered", m.urgentTotal ? `${m.urgentCovered} of ${m.urgentTotal}` : "none urgent"],
    ["Overdue covered", m.overdueTotal ? `${m.overdueCovered} of ${m.overdueTotal}` : "none overdue"],
    ["Revenue covered (estimate)", `${money(m.revenueCoveredCents)}${m.revenueUnknownLoads ? ` + ${m.revenueUnknownLoads} without a rate` : ""}`],
    ["Margin", "Not evaluated — no cost data"],
    ["Trucks / drivers used", `${m.trucksUsed} / ${m.driversUsed}`],
    ["Average truck fill", m.averageFill === null ? "Unknown capacity" : `${Math.round(m.averageFill * 100)}%`],
    ["Site changes (empty-trip proxy)", String(m.siteChanges)],
    ["Driver workload spread", m.workloadSpread ? `${m.workloadSpread} load(s)` : "Even"],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-line py-1">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-semibold text-ink tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Whole-day plans from the optimization core (src/lib/optimization/plan.ts): compare the plan for the chosen
 * priorities with its alternatives, review each assignment and approve a selection. Approval re-checks every
 * assignment against current data and assigns through public.assign_load; nothing else is changed.
 */
export function OptimizationPlanner({ date, timezone, loads, revenueCents, result, canEdit, ai, preset, priorities }: {
  date: string; timezone: string; loads: SmartLoad[]; revenueCents: Record<string, number | null>; result: Optimization; canEdit: boolean;
  ai: PlanAiState; preset: string | null; priorities: Record<string, number>;
}) {
  const router = useRouter();
  const [active, setActive] = useState(0);
  const plan = result.plans[active];
  const byId = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(result.plans[0]?.assignments.map((a) => a.loadId) ?? []));
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ApprovalOutcome[] | null>(null);

  if (!loads.length) {
    return (
      <div className="rounded-lg border border-line bg-card p-6 text-sm text-muted">
        No unassigned loads on this day. Plan loads for scheduled orders on the Dispatch board first, or choose another day.
      </div>
    );
  }

  const choose = (i: number) => {
    setActive(i);
    setSelected(new Set(result.plans[i].assignments.map((a) => a.loadId)));
    setOutcomes(null);
  };
  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  async function approve() {
    const items = plan.assignments.filter((a) => selected.has(a.loadId)).map((a) => ({ loadId: a.loadId, truckId: a.truckId, trailerId: a.trailerId, driverId: a.driverId }));
    if (!items.length) return;
    setBusy(true);
    const r = await approvePlanAssignments({ date, planLabel: plan.label, items });
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    setOutcomes(r.data.outcomes);
    if (r.data.outcomes.every((o) => o.assigned)) toast.success(r.message ?? "Approved.");
    else toast.warning(r.message ?? "Some assignments were not made.");
    router.refresh();
  }

  const loadLabel = (id: string) => {
    const l = byId.get(id);
    return l ? `${l.order_number} load ${l.load_number}` : "Load";
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="plans-title" className="rounded-lg border border-line bg-card p-4">
        <h2 id="plans-title" className="text-base font-bold text-ink">Plans</h2>
        <div role="tablist" aria-label="Plans" className="mt-3 flex flex-wrap gap-2">
          {result.plans.map((p, i) => (
            <button key={p.key} role="tab" aria-selected={i === active} onClick={() => choose(i)} className={`rounded-md border px-3 py-2 text-left text-sm ${i === active ? "border-strong bg-surface" : "border-line hover:bg-surface"}`}>
              <span className="block font-semibold text-ink">{p.label}{i === 0 ? " (your priorities)" : ""}</span>
              <span className="block text-xs text-muted">{p.metrics.covered} of {p.metrics.loads} loads · {money(p.metrics.revenueCoveredCents)} est.</span>
            </button>
          ))}
        </div>
        <div className="mt-4" role="tabpanel" aria-label={plan.label}>
          <Metrics plan={plan} />
          {active > 0 && (
            <p className="mt-3 text-sm text-ink">
              <span className="font-semibold">Compared with your priorities:</span> {result.tradeoffs[active - 1]?.differences.join(" · ")}
            </p>
          )}
        </div>
      </section>

      <PlanExplanation ai={ai} date={date} preset={preset} priorities={priorities} planKey={plan.key} planLabel={plan.label} />

      <section aria-labelledby="assign-title" className="rounded-lg border border-line bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 id="assign-title" className="text-base font-bold text-ink">Proposed assignments · {plan.label}</h2>
          {canEdit ? (
            <Button onClick={approve} loading={busy} disabled={busy || !plan.assignments.some((a) => selected.has(a.loadId))}>
              Approve {plan.assignments.filter((a) => selected.has(a.loadId)).length} selected
            </Button>
          ) : (
            <span className="text-sm text-muted">Viewing only — approving needs dispatch edit access.</span>
          )}
        </div>
        <ul className="divide-y divide-line">
          {plan.assignments.map((a) => {
            const l = byId.get(a.loadId)!;
            const outcome = outcomes?.find((o) => o.loadId === a.loadId);
            const rev = revenueCents[a.loadId];
            return (
              <li key={a.loadId} className="flex gap-3 px-4 py-3">
                {canEdit && (
                  <input type="checkbox" className="mt-1 size-4 accent-brand" checked={selected.has(a.loadId)} onChange={() => toggle(a.loadId)} aria-label={`Approve ${loadLabel(a.loadId)}`} disabled={outcome?.assigned} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">
                    {loadLabel(a.loadId)} · {time(l.starts_at, timezone)}–{time(l.ends_at, timezone)} · {l.customer_name ?? "Customer"} → Truck {a.truckLabel}{a.trailerLabel ? ` + trailer ${a.trailerLabel}` : ""}, {a.driverLabel}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {l.planned_quantity !== null ? `${l.planned_quantity} ${l.unit_code ?? ""} · ` : ""}{rev === null || rev === undefined ? "No rate to estimate revenue" : `${money(rev)} estimated revenue`}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {l.urgent && <Badge tone="critical">Urgent</Badge>}
                    <Badge tone={a.status === "verified" ? "green" : "amber"}>{a.status === "verified" ? "Verified feasible" : "Needs review"}</Badge>
                    {outcome && <Badge tone={outcome.assigned ? "green" : "red"}>{outcome.assigned ? "Assigned" : "Not assigned"}</Badge>}
                  </div>
                  {a.reasons.length > 0 && <p className="mt-1.5 text-sm text-ink">Why: {a.reasons.join("; ")}.</p>}
                  {a.review.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted">
                      {a.review.map((r) => <li key={r}>{r}</li>)}
                    </ul>
                  )}
                  {outcome && !outcome.assigned && <p role="alert" className="mt-1 text-sm text-critical">{outcome.message}</p>}
                  {outcome?.warnings.map((w) => <p key={w} className="mt-1 text-xs text-muted">{w}</p>)}
                </div>
              </li>
            );
          })}
          {plan.uncovered.map((u) => (
            <li key={u.loadId} className="px-4 py-3">
              <p className="text-sm font-semibold text-ink">{loadLabel(u.loadId)} · not covered</p>
              <div className="mt-1 flex gap-1.5"><Badge tone="red">Blocked</Badge>{byId.get(u.loadId)?.urgent && <Badge tone="critical">Urgent</Badge>}</div>
              <p className="mt-1 text-sm text-muted">{u.why}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="data-title" className="rounded-lg border border-line bg-card p-4">
        <h2 id="data-title" className="text-base font-bold text-ink">Missing or estimated information</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
          {result.dataNotes.map((n) => <li key={n}>{n}</li>)}
        </ul>
        <p className="mt-3 text-xs text-muted">Confirmed assignments are never changed by a plan. Approving re-checks each assignment against the latest data before it is made.</p>
      </section>
    </div>
  );
}
