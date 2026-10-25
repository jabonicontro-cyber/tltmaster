"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { HOS_CONFIRMATION } from "@/lib/hos";
import { approveRecommendation, reconsiderRecommendations, rejectRecommendation } from "@/app/(app)/dispatch/actions";
import type { BoardPlan, Candidate, ExclusionGroup } from "@/lib/dispatch/smart";
import { HOS_NOTE } from "@/lib/dispatch/smart";
import { formatDate } from "@/lib/dates";
import { withReturn } from "@/lib/safe-redirect";

const time = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));

/** One line per reason: how many trucks or drivers it rules out, with a few of them named. */
function ExclusionList({ groups, className }: { groups: ExclusionGroup[]; className?: string }) {
  return (
    <ul className={className}>
      {groups.map((g) => (
        <li key={`${g.kind}:${g.reason}`}>
          <span className="font-medium text-ink">{g.count} {g.kind === "truck" ? (g.count === 1 ? "truck" : "trucks") : (g.count === 1 ? "driver" : "drivers")}:</span> {g.reason}{" "}
          <span className="text-xs">({g.kind === "truck" ? "truck " : ""}{g.examples.join(", ")}{g.count > g.examples.length ? `, and ${g.count - g.examples.length} more` : ""})</span>
        </li>
      ))}
    </ul>
  );
}

function PlanCard({ plan, canEdit, timezone, back }: { plan: BoardPlan; canEdit: boolean; timezone: string; back: string }) {
  const router = useRouter();
  const options = plan.proposal ? [plan.proposal, ...plan.alternatives] : [];
  const [choice, setChoice] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  // Hidden as soon as the approval succeeds; the board's recompute (router.refresh) can take a few seconds.
  const [assigned, setAssigned] = useState(false);
  // Hours of service are not in Taviron: approving asks the dispatcher to confirm them (lib/hos).
  const [confirming, setConfirming] = useState(false);
  const chosen: Candidate | undefined = options[choice];
  const l = plan.load;

  async function approve(): Promise<string | void> {
    if (!chosen) return;
    setBusy("approve");
    setError(null);
    const r = await approveRecommendation({ loadId: l.id, truckId: chosen.truckId, trailerId: chosen.trailerId ?? null, driverId: chosen.driverId, loadDate: l.load_date, hosConfirmed: true });
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      router.refresh();
      return;
    }
    toast.success(`${l.order_number} load ${l.load_number}: assigned to truck ${chosen.truckLabel} and ${chosen.driverLabel}.`);
    setAssigned(true);
    router.refresh();
  }
  async function reject() {
    if (!chosen) return;
    setBusy("reject");
    const r = await rejectRecommendation({ loadId: l.id, truckId: chosen.truckId, driverId: chosen.driverId, reason });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setRejecting(false);
    setReason("");
    setChoice(0);
    router.refresh();
  }
  async function reconsider() {
    setBusy("reconsider");
    const r = await reconsiderRecommendations(l.id);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  const time2 = `${formatDate(l.load_date)} · ${time(l.starts_at, timezone)}–${time(l.ends_at, timezone)}`;
  const urgentRank = plan.priority.rank;
  if (assigned) return null;
  return (
    <li className="px-4 py-3 sm:px-5" aria-label={`${l.order_number} load ${l.load_number}`}>
      {/* One line per load: what, when, for whom, and how urgent. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link href={withReturn(`/orders/${l.order_id}`, back)} className="font-semibold tabular text-ink hover:underline">{l.order_number}</Link>
        <span className="text-sm text-ink">Load {l.load_number}</span>
        <span className="text-sm text-muted tabular">{time2}</span>
        <span className="min-w-0 truncate text-sm text-muted">{l.customer_name}{l.planned_quantity !== null ? ` · ${l.planned_quantity} ${l.unit_code === "cu_yd" ? "cu yd" : l.unit_code ?? ""}` : ""}</span>
        {plan.priority.reasons.slice(0, 1).map((r) => (
          <Badge key={r} tone={urgentRank === 0 ? "red" : urgentRank === 1 ? "amber" : "gray"}>{r}</Badge>
        ))}
      </div>

      {plan.proposal ? (
        <div className="mt-2.5 rounded-2xl border border-line bg-surface/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="text-muted">Proposed: </span>
              <span className="font-semibold text-ink">Truck {chosen?.truckLabel}</span>
              <span className="text-muted"> with </span>
              <span className="font-semibold text-ink">{chosen?.driverLabel}</span>
            </p>
            {canEdit ? (
              <div className="flex flex-wrap items-center gap-2">
                {rejecting ? (
                  <>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Why not? (optional)" aria-label="Reason for rejecting" className="h-8 rounded-control border border-line bg-card px-2 text-sm" />
                    <Button size="sm" variant="secondary" loading={busy === "reject"} onClick={reject}>Reject this option</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}>Reject…</Button>
                    <Button size="sm" loading={busy === "approve"} onClick={() => setConfirming(true)}>Approve and assign</Button>
                  </>
                )}
                {chosen && (
                  <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Confirm hours of service"
                    description={`Assign ${l.order_number} load ${l.load_number} to ${chosen.driverLabel} with truck ${chosen.truckLabel}. ${HOS_CONFIRMATION}`}
                    confirmLabel="I checked — assign" onConfirm={approve} />
                )}
              </div>
            ) : (
              <span className="text-xs text-muted">Approving needs dispatch edit access</span>
            )}
          </div>
          {chosen && chosen.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-sm text-amber-900">
              {chosen.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          <details className="mt-1.5 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-muted hover:text-ink">Why this option{options.length > 1 ? ` · ${options.length - 1} other option${options.length === 2 ? "" : "s"}` : ""}</summary>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">
              {chosen?.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
            {options.length > 1 ? (
              <fieldset className="mt-2">
                <legend className="text-xs font-semibold text-ink">Choose another option</legend>
                {options.map((o, i) => (
                  <label key={`${o.truckId}-${o.driverId}`} className="mr-4 inline-flex items-center gap-1.5 text-sm">
                    <input type="radio" name={`opt-${l.id}`} checked={choice === i} onChange={() => setChoice(i)} className="accent-brand" />
                    {o.truckLabel} · {o.driverLabel}{i === 0 ? " (best)" : ""}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </details>
        </div>
      ) : (
        <details className="group mt-2 rounded-2xl border border-line p-3 text-sm">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2">
            <Badge tone="amber">No option</Badge>
            <span className="text-ink">{plan.blocked?.why[0] ?? "No feasible truck and driver."}</span>
            {plan.blocked && plan.blocked.options.length > 0 && <span className="text-xs text-muted">· {plan.blocked.options.length} idea{plan.blocked.options.length === 1 ? "" : "s"}</span>}
            <span className="ml-auto text-xs font-medium text-muted group-open:hidden">Details</span>
          </summary>
          <div className="mt-2 space-y-2 border-t border-line pt-2">
            {plan.blocked && plan.blocked.why.length > 1 && (
              <ul className="list-disc pl-5 text-ink">{plan.blocked.why.slice(1).map((w) => <li key={w}>{w}</li>)}</ul>
            )}
            {plan.blocked && plan.blocked.options.length > 0 ? (
              <div>
                <p className="text-xs font-semibold text-ink">Ideas — each needs your decision; nothing is changed automatically</p>
                <ul className="list-disc pl-5 text-muted">{plan.blocked.options.map((o) => <li key={o}>{o}</li>)}</ul>
              </div>
            ) : null}
            {plan.excluded.groups.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-ink">Why trucks and drivers were ruled out</p>
                <ExclusionList groups={plan.excluded.groups} className="mt-0.5 space-y-0.5 text-muted" />
              </div>
            )}
          </div>
        </details>
      )}

      {error ? <p role="alert" className="mt-2 text-sm text-critical">{error}</p> : null}
      {plan.rejectedPairs > 0 && canEdit ? (
        <p className="mt-1.5 text-xs text-muted">
          {plan.rejectedPairs} option{plan.rejectedPairs === 1 ? "" : "s"} rejected.{" "}
          <button type="button" className="font-semibold underline" onClick={reconsider} disabled={busy === "reconsider"}>Reconsider</button>
        </p>
      ) : null}
      {plan.proposal && plan.excluded.trucks + plan.excluded.drivers > 0 ? (
        <details className="mt-1.5 text-sm">
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">Why not the others ({plan.excluded.trucks} trucks, {plan.excluded.drivers} drivers)</summary>
          <ExclusionList groups={plan.excluded.groups} className="mt-1 space-y-0.5 pl-4 text-muted" />
        </details>
      ) : null}
    </li>
  );
}

/**
 * Smart Dispatch on the dispatch board: proposals for every unassigned load in
 * the next few days, most urgent first. Proposals are suggestions only; each
 * one is assigned only when a dispatcher approves it.
 */
export function SmartDispatch({ plans, from, to, horizon, canEdit, timezone, back }: { plans: BoardPlan[]; from: string; to: string; horizon: number; canEdit: boolean; timezone: string; back: string }) {
  const feasible = plans.filter((p) => p.proposal).length;
  // The most urgent few first; the rest one click away, so the board below stays reachable.
  const [all, setAll] = useState(false);
  const FIRST = 6;
  const shown = all ? plans : plans.slice(0, FIRST);
  return (
    <details open className="mb-4 rounded-panel border border-line/70 bg-card shadow-card" aria-label="Smart Dispatch">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <Lightbulb className="size-5 text-brand-fg" aria-hidden />
        <span className="font-bold">Smart Dispatch</span>
        <span className="text-sm text-muted">
          {plans.length === 0 ? "No unassigned loads" : `${plans.length} unassigned load${plans.length === 1 ? "" : "s"} · ${feasible} with a proposal · ${plans.length - feasible} need attention`} · {formatDate(from)}–{formatDate(to)}
        </span>
      </summary>
      {/* Outside the summary: links inside it would also toggle the section (nested interactive controls). */}
      <nav aria-label="Smart Dispatch period" className="flex justify-end gap-1 border-b border-line px-4 py-1.5 text-xs">
        {[1, 3, 7].map((d) => (
          <Link key={d} href={`/dispatch?horizon=${d}`} aria-current={d === horizon ? "page" : undefined}
            className={`rounded border px-2 py-0.5 ${d === horizon ? "border-strong bg-strong text-white" : "border-line"}`}>
            {d === 1 ? "Today" : `${d} days`}
          </Link>
        ))}
      </nav>
      <details className="border-b border-line px-4 py-2 text-xs text-muted sm:px-5">
        <summary className="cursor-pointer">
          Proposals only — nothing is assigned until you approve. <span className="font-medium text-amber-900">Hours of service are not checked.</span> <span className="underline">About these proposals</span>
        </summary>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5" aria-label="Limits of these proposals">
          <li>Every approval is checked again against current availability, qualifications, capacity, bookings and the shop schedule.</li>
          {(plans[0]?.notes ?? []).map((n) => <li key={n}>{n}</li>)}
          {plans.length === 0 && <li>{HOS_NOTE}</li>}
        </ul>
      </details>
      {plans.length > 0 ? <ul className="divide-y divide-line">{shown.map((p) => <PlanCard key={p.load.id} plan={p} canEdit={canEdit} timezone={timezone} back={back} />)}</ul> : null}
      {plans.length > FIRST && (
        <div className="border-t border-line px-4 py-2.5 text-center sm:px-5">
          <button type="button" onClick={() => setAll((v) => !v)} className="text-sm font-medium text-brand-fg hover:underline">
            {all ? "Show fewer" : `Show all ${plans.length} loads`}
          </button>
        </div>
      )}
    </details>
  );
}
