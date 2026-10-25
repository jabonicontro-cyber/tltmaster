"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { approvePlanAssignments, type ApprovalOutcome } from "@/app/(app)/dispatch/plan/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { HOS_CONFIRMATION } from "@/lib/hos";
import { PlanExplanation, type PlanAiState } from "@/components/dispatch/plan-explanation";
import type { SmartLoad } from "@/lib/dispatch/smart";
import type { LoadExplanation, Unavailable } from "@/lib/optimization/availability";
import type { Optimization, Plan } from "@/lib/optimization/plan";
import { formatDateLong } from "@/lib/dates";
import Link from "next/link";

const time = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

/** First review item, without its parenthetical detail: the row's short reason; the full list is under the explanation. */
const short = (r: string) => r.replace(/\s*\([^)]*\)\.?$/, "").replace(/\.$/, "");

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-line px-3 py-2.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold text-ink tabular">{value}</dd>
      {note && <dd className="text-xs text-muted">{note}</dd>}
    </div>
  );
}

function Summary({ plan }: { plan: Plan }) {
  const m = plan.metrics;
  const review = plan.assignments.filter((a) => a.status === "needs_review").length;
  const details: Array<[string, string]> = [
    ["Urgent covered", m.urgentTotal ? `${m.urgentCovered} of ${m.urgentTotal}` : "None urgent"],
    ["Overdue covered", m.overdueTotal ? `${m.overdueCovered} of ${m.overdueTotal}` : "None overdue"],
    ["Average truck fill", m.averageFill === null ? "Unknown capacity" : `${Math.round(m.averageFill * 100)}%`],
    ["Site changes (empty-trip proxy)", String(m.siteChanges)],
    ["Driver workload spread", m.workloadSpread ? `${m.workloadSpread} load(s)` : "Even"],
  ];
  return (
    <>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Loads covered" value={`${m.covered} of ${m.loads}`} note={plan.uncovered.length ? `${plan.uncovered.length} blocked` : "Every open load"} />
        <Stat label="Estimated revenue" value={money(m.revenueCoveredCents)}
          note={`${m.revenueUnknownLoads ? `+ ${m.revenueUnknownLoads} without a rate · ` : ""}Margin: Not evaluated — no cost data`} />
        <Stat label="Trucks / drivers used" value={`${m.trucksUsed} / ${m.driversUsed}`} />
        <Stat label="Need review" value={String(review)} note={review ? "Check before approving" : "None"} />
      </dl>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-semibold text-ink">More plan details</summary>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {details.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-line py-1">
              <dt className="text-muted">{k}</dt>
              <dd className="text-right font-semibold text-ink tabular">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">
          Truck fill is how much recorded capacity the plan uses, not a readiness check: a full truck can still need review. Revenue is an
          estimate (order rate × planned quantity); without operating costs it is not profit.
        </p>
      </details>
    </>
  );
}

/**
 * Whole-day plans from the optimization core (src/lib/optimization/plan.ts): compare the plan for the chosen
 * priorities with its alternatives, review each assignment and approve a selection. Approval re-checks every
 * assignment against current data and assigns through public.assign_load; nothing else is changed.
 */
function UnavailableList({ items }: { items: Unavailable[] }) {
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {items.map((u) => (
        <li key={`${u.kind}:${u.id}`}>
          <span className="font-semibold text-ink">{u.label}</span> <span className="text-muted">— {u.reasons.join(" ")}</span>
        </li>
      ))}
    </ul>
  );
}

const STATUS = {
  verified: { label: "Recommended", tone: "green" },
  needs_review: { label: "Needs review", tone: "amber" },
} as const;

export function OptimizationPlanner({ date, timezone, loads, revenueCents, result, canEdit, ai, preset, priorities, explanations = [], unavailable = [], upcoming = [] }: {
  date: string; timezone: string; loads: SmartLoad[]; revenueCents: Record<string, number | null>; result: Optimization; canEdit: boolean;
  ai: PlanAiState; preset: string | null; priorities: Record<string, number>;
  /** Why loads with no feasible truck, trailer and driver are blocked (src/lib/optimization/availability.ts). */
  explanations?: LoadExplanation[];
  /** Trucks, trailers and drivers that cannot take any open load this day. */
  unavailable?: Unavailable[];
  /** Other days with open loads (shown when this day has none); null when they could not be read. */
  upcoming?: Array<{ date: string; open: number }> | null;
}) {
  const router = useRouter();
  const [active, setActive] = useState(0);
  const plan = result.plans[active];
  const byId = useMemo(() => new Map(loads.map((l) => [l.id, l])), [loads]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(result.plans[0]?.assignments.map((a) => a.loadId) ?? []));
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ApprovalOutcome[] | null>(null);
  // Hours of service are not in Taviron: approving asks the dispatcher to confirm them (lib/hos).
  const [confirming, setConfirming] = useState(false);

  if (!loads.length) {
    return (
      <div className="rounded-panel border border-line/70 bg-card shadow-card p-6 text-sm" role="status">
        <p className="font-semibold text-ink">Nothing to plan on {formatDateLong(date)}: every load that day already has a truck and driver, or no loads are planned yet.</p>
        {upcoming === null ? (
          <p className="mt-2 text-muted">Other days could not be checked right now.</p>
        ) : upcoming.length ? (
          <div className="mt-3">
            <p className="text-muted">Days in the next two weeks with loads waiting for a truck and driver:</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {upcoming.map((d) => (
                <li key={d.date}>
                  <Link href={`/dispatch/plan?date=${d.date}${preset ? `&preset=${preset}` : ""}`} className="inline-flex min-h-10 items-center rounded-xl border border-line px-3 font-semibold text-ink hover:bg-surface">
                    {formatDateLong(d.date)} · {d.open} open
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-2 text-muted">No other day in the next two weeks has open loads either.</p>
        )}
        <p className="mt-3 text-muted">
          To plan more work, add loads to scheduled orders on the <Link href={`/dispatch?date=${date}`} className="font-semibold text-brand-fg hover:underline">Dispatch board</Link>, or give orders waiting for a delivery date a schedule (listed there under &ldquo;Needs scheduling&rdquo;).
        </p>
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

  async function approve(): Promise<string | void> {
    const items = plan.assignments.filter((a) => selected.has(a.loadId) && !outcomes?.find((o) => o.loadId === a.loadId)?.assigned).map((a) => ({ loadId: a.loadId, truckId: a.truckId, trailerId: a.trailerId, driverId: a.driverId }));
    if (!items.length) return;
    setBusy(true);
    const r = await approvePlanAssignments({ date, planLabel: plan.label, items, hosConfirmed: true });
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

  const open = plan.assignments.filter((a) => !outcomes?.find((o) => o.loadId === a.loadId)?.assigned);
  const chosen = open.filter((a) => selected.has(a.loadId));
  const reviewCount = plan.assignments.filter((a) => a.status === "needs_review").length;

  return (
    <div className="space-y-5">
      <section aria-labelledby="plans-title" className="rounded-panel border border-line/70 bg-card shadow-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="plans-title" className="text-base font-bold text-ink">Plans</h2>
          <div role="tablist" aria-label="Plans" className="flex flex-wrap gap-2">
            {result.plans.map((p, i) => (
              <button key={p.key} role="tab" aria-selected={i === active} onClick={() => choose(i)}
                className={`rounded-xl border px-3 py-1.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand ${i === active ? "border-strong bg-surface" : "border-line hover:bg-surface"}`}>
                <span className="block font-semibold text-ink">{p.label}{i === 0 ? " (your priorities)" : ""}</span>
                <span className="block text-xs text-muted">{p.metrics.covered} of {p.metrics.loads} loads · {money(p.metrics.revenueCoveredCents)} est.</span>
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4" role="tabpanel" aria-label={plan.label}>
          <Summary plan={plan} />
          {active > 0 && (
            <p className="mt-3 text-sm text-ink">
              <span className="font-semibold">Compared with your priorities:</span> {result.tradeoffs[active - 1]?.differences.join(" · ")}
            </p>
          )}
        </div>
      </section>

      {result.dataNotes.length > 0 && (
        <section aria-labelledby="data-title" className="rounded-2xl border border-line bg-surface px-4 py-3">
          <h2 id="data-title" className="text-sm font-semibold text-ink">Missing or estimated information</h2>
          <p className="mt-0.5 text-sm text-muted">
            Information Taviron does not have yet, not problems with this plan. Checks that depend on it show as Needs review on each assignment.
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-sm font-semibold text-brand-fg">Details ({result.dataNotes.length})</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
              {result.dataNotes.map((n) => <li key={n}>{n}</li>)}
            </ul>
            <p className="mt-2 text-xs text-muted">Confirmed assignments are never changed by a plan. Approving re-checks each assignment against the latest data before it is made.</p>
          </details>
        </section>
      )}

      <section aria-labelledby="assign-title" className="rounded-panel border border-line/70 bg-card shadow-card">
        <div className="border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="assign-title" className="text-base font-bold text-ink">Proposed assignments · {plan.label}</h2>
            {canEdit && open.length > 0 && (
              <div className="flex gap-2 text-sm">
                <button type="button" className="font-semibold text-brand-fg hover:underline" onClick={() => setSelected(new Set(open.map((a) => a.loadId)))}>Select all</button>
                <span className="text-muted" aria-hidden>·</span>
                <button type="button" className="font-semibold text-brand-fg hover:underline" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {plan.assignments.length - reviewCount} recommended · {reviewCount} need review · {plan.uncovered.length} blocked.
            Recommended passed every check Taviron ran; Needs review has a check left for you; Blocked fails a hard rule.
          </p>
        </div>
        <ul className="divide-y divide-line">
          {plan.assignments.map((a) => {
            const l = byId.get(a.loadId)!;
            const outcome = outcomes?.find((o) => o.loadId === a.loadId);
            const rev = revenueCents[a.loadId];
            const status = STATUS[a.status];
            return (
              <li key={a.loadId} className="flex gap-3 px-4 py-3">
                {canEdit && (
                  <input type="checkbox" className="mt-1 size-4 shrink-0 accent-brand" checked={selected.has(a.loadId)} onChange={() => toggle(a.loadId)} aria-label={`Approve ${loadLabel(a.loadId)}`} disabled={outcome?.assigned} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <p className="text-sm font-semibold text-ink">
                      {loadLabel(a.loadId)} · <span className="tabular">{time(l.starts_at, timezone)}–{time(l.ends_at, timezone)}</span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {l.urgent && <Badge tone="critical">Urgent</Badge>}
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {outcome && <Badge tone={outcome.assigned ? "green" : "red"}>{outcome.assigned ? "Assigned" : "Not assigned"}</Badge>}
                    </div>
                  </div>
                  <p className="mt-0.5 text-sm text-ink">
                    {l.customer_name ?? "Customer"} → Truck {a.truckLabel}{a.trailerLabel ? ` + trailer ${a.trailerLabel}` : ""} · {a.driverLabel}
                  </p>
                  <p className="text-xs text-muted">
                    {l.planned_quantity !== null ? `${l.planned_quantity} ${l.unit_code ?? ""} · ` : ""}{rev === null || rev === undefined ? "No rate to estimate revenue" : `${money(rev)} estimated revenue`}
                  </p>
                  {a.review.length > 0 && (
                    <p className="mt-1 text-sm text-amber-900">
                      Check: {short(a.review[0])}{a.review.length > 1 ? ` + ${a.review.length - 1} more` : ""}
                    </p>
                  )}
                  {(a.reasons.length > 0 || a.review.length > 0) && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-semibold text-brand-fg">View explanation</summary>
                      {a.reasons.length > 0 && <p className="mt-1 text-sm text-ink">Why: {a.reasons.join("; ")}.</p>}
                      {a.review.length > 0 && (
                        <>
                          <p className="mt-1 text-xs font-semibold text-ink">Check before approving</p>
                          <ul className="list-disc pl-5 text-xs text-muted">{a.review.map((r) => <li key={r}>{r}</li>)}</ul>
                        </>
                      )}
                    </details>
                  )}
                  {outcome && !outcome.assigned && <p role="alert" className="mt-1 text-sm text-critical">{outcome.message}</p>}
                  {outcome?.warnings.map((w) => <p key={w} className="mt-1 text-xs text-muted">{w}</p>)}
                </div>
              </li>
            );
          })}
          {plan.uncovered.map((u) => {
            const l = byId.get(u.loadId);
            const ex = explanations.find((e) => e.loadId === u.loadId);
            return (
              <li key={u.loadId} className="flex gap-3 px-4 py-3">
                {canEdit && <span className="size-4 shrink-0" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <p className="text-sm font-semibold text-ink">
                      {loadLabel(u.loadId)}{l ? <> · <span className="tabular">{time(l.starts_at, timezone)}–{time(l.ends_at, timezone)}</span></> : null} · not covered
                    </p>
                    <div className="flex gap-1.5">{l?.urgent && <Badge tone="critical">Urgent</Badge>}<Badge tone="red">Blocked</Badge></div>
                  </div>
                  <p className="mt-0.5 text-sm text-ink">{ex ? ex.summary : u.why}</p>
                  {ex && ex.unavailable.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs font-semibold text-brand-fg">Why each truck, trailer or driver cannot take it ({ex.unavailable.length})</summary>
                      <UnavailableList items={ex.unavailable} />
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-b-lg border-t border-line bg-card px-4 py-3">
          {canEdit ? (
            <>
              <p className="text-sm text-ink" aria-live="polite">
                <span className="font-semibold tabular">{chosen.length}</span> of {open.length} selected
                {chosen.some((a) => a.status === "needs_review") ? <span className="text-muted"> · you confirm hours of service when approving</span> : null}
              </p>
              <Button onClick={() => setConfirming(true)} loading={busy} disabled={busy || chosen.length === 0}>
                Approve {chosen.length} selected
              </Button>
              <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Confirm hours of service"
                description={`Assign ${chosen.length} selected load(s) from ${plan.label}. ${HOS_CONFIRMATION}`}
                confirmLabel="I checked — approve" onConfirm={approve} />
            </>
          ) : (
            <span className="text-sm text-muted">Viewing only — approving needs dispatch edit access.</span>
          )}
        </div>
      </section>

      <PlanExplanation ai={ai} date={date} preset={preset} priorities={priorities} planKey={plan.key} planLabel={plan.label} />

      {unavailable.length > 0 && (
        <section aria-labelledby="unavailable-title" className="rounded-panel border border-line/70 bg-card shadow-card px-4 py-3">
          <details>
            <summary className="cursor-pointer">
              <h2 id="unavailable-title" className="inline text-sm font-semibold text-ink">Unavailable resources · {unavailable.length}</h2>
              <span className="ml-2 text-xs text-muted">Not available for any open load this day</span>
            </summary>
            <p className="mt-2 text-xs text-muted">From Taviron&apos;s records: service status, maintenance, reports, bookings, qualifications and time off. Resources busy for only part of the day appear under the loads they block.</p>
            <UnavailableList items={unavailable} />
          </details>
        </section>
      )}
    </div>
  );
}
