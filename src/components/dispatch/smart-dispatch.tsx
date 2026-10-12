"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { approveRecommendation, reconsiderRecommendations, rejectRecommendation } from "@/app/(app)/dispatch/actions";
import type { Candidate, LoadPlan } from "@/lib/dispatch/smart";
import { HOS_NOTE } from "@/lib/dispatch/smart";
import { formatDate } from "@/lib/dates";
import { withReturn } from "@/lib/safe-redirect";

const time = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));

function PlanCard({ plan, canEdit, timezone, back }: { plan: LoadPlan; canEdit: boolean; timezone: string; back: string }) {
  const router = useRouter();
  const options = plan.proposal ? [plan.proposal, ...plan.alternatives] : [];
  const [choice, setChoice] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const chosen: Candidate | undefined = options[choice];
  const l = plan.load;

  async function approve() {
    if (!chosen) return;
    setBusy("approve");
    setError(null);
    const r = await approveRecommendation({ loadId: l.id, truckId: chosen.truckId, driverId: chosen.driverId, loadDate: l.load_date });
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      router.refresh();
      return;
    }
    toast.success(`${l.order_number} load ${l.load_number}: assigned to truck ${chosen.truckLabel} and ${chosen.driverLabel}.`);
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

  return (
    <li className="space-y-2 px-4 py-3" aria-label={`${l.order_number} load ${l.load_number}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={withReturn(`/orders/${l.order_id}`, back)} className="font-bold tabular hover:underline">{l.order_number}</Link>
        <span className="text-sm">load {l.load_number} · {formatDate(l.load_date)} {time(l.starts_at, timezone)}–{time(l.ends_at, timezone)}</span>
        <span className="text-sm text-muted">{l.customer_name}{l.planned_quantity !== null ? ` · ${l.planned_quantity} ${l.unit_code === "cu_yd" ? "cu yd" : l.unit_code ?? ""}` : ""}</span>
        {plan.priority.reasons.map((r) => (
          <Badge key={r} tone={plan.priority.rank === 0 ? "red" : plan.priority.rank === 1 ? "amber" : "gray"}>{r}</Badge>
        ))}
      </div>

      {plan.proposal ? (
        <div className="rounded-md border border-blue-200 bg-blue-50/60 p-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="blue">Proposed — not assigned</Badge>
            <span>
              Truck <strong>{chosen?.truckLabel}</strong> with <strong>{chosen?.driverLabel}</strong>
            </span>
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
            {chosen?.reasons.map((r) => <li key={r}>{r}</li>)}
            {chosen?.warnings.map((w) => <li key={w} className="text-amber-900">Warning: {w}</li>)}
          </ul>
          {options.length > 1 ? (
            <fieldset className="mt-2 text-sm">
              <legend className="font-semibold">Feasible options</legend>
              {options.map((o, i) => (
                <label key={`${o.truckId}-${o.driverId}`} className="mr-4 inline-flex items-center gap-1">
                  <input type="radio" name={`opt-${l.id}`} checked={choice === i} onChange={() => setChoice(i)} className="accent-brand" />
                  {o.truckLabel} · {o.driverLabel}{i === 0 ? " (best)" : ""}
                </label>
              ))}
            </fieldset>
          ) : null}
          {canEdit ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" loading={busy === "approve"} onClick={approve}>Approve and assign</Button>
              {rejecting ? (
                <>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder="Why not? (optional)" aria-label="Reason for rejecting" className="h-8 rounded-md border border-line px-2 text-sm" />
                  <Button size="sm" variant="secondary" loading={busy === "reject"} onClick={reject}>Reject this option</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
                </>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>Reject…</Button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">Approving needs the dispatch.edit permission.</p>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
          <p className="font-semibold text-red-900">No feasible assignment</p>
          <ul className="mt-1 list-disc pl-5">
            {plan.blocked?.why.map((w) => <li key={w}>{w}</li>)}
          </ul>
          {plan.blocked && plan.blocked.options.length > 0 ? (
            <>
              <p className="mt-2 font-semibold">Options — each needs a dispatcher&apos;s decision; none is applied automatically</p>
              <ul className="list-disc pl-5">
                {plan.blocked.options.map((o) => <li key={o}>{o}</li>)}
              </ul>
            </>
          ) : null}
        </div>
      )}

      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      {plan.rejectedPairs > 0 && canEdit ? (
        <p className="text-xs text-muted">
          {plan.rejectedPairs} option{plan.rejectedPairs === 1 ? "" : "s"} rejected for this load.{" "}
          <button type="button" className="font-semibold underline" onClick={reconsider} disabled={busy === "reconsider"}>Reconsider them</button>
        </p>
      ) : null}
      {plan.excludedTrucks.length + plan.excludedDrivers.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Why not the others ({plan.excludedTrucks.length} trucks, {plan.excludedDrivers.length} drivers)</summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {plan.excludedTrucks.map((t) => <li key={t.id}><strong>Truck {t.label}:</strong> {t.reasons.join(" ")}</li>)}
            {plan.excludedDrivers.map((d) => <li key={d.id}><strong>{d.label}:</strong> {d.reasons.join(" ")}</li>)}
          </ul>
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
export function SmartDispatch({ plans, from, to, horizon, canEdit, timezone, back }: { plans: LoadPlan[]; from: string; to: string; horizon: number; canEdit: boolean; timezone: string; back: string }) {
  const feasible = plans.filter((p) => p.proposal).length;
  return (
    <details open className="mb-4 rounded-lg border border-line bg-card" aria-label="Smart Dispatch">
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
      <p className="border-b border-line px-4 py-2 text-xs text-muted">
        Proposals only — nothing is assigned until you approve, and every approval is checked again against current availability, qualifications, capacity, bookings and the shop schedule. {plans[0]?.notes[0]}
      </p>
      <ul className="border-b border-line px-4 py-2 text-xs" aria-label="Limits of these proposals">
        <li className="font-medium text-amber-900">{HOS_NOTE}</li>
        {(plans[0]?.notes ?? []).slice(1).filter((n) => n !== HOS_NOTE).map((n) => <li key={n} className="text-muted">{n}</li>)}
      </ul>
      {plans.length > 0 ? <ul className="divide-y divide-line">{plans.map((p) => <PlanCard key={p.load.id} plan={p} canEdit={canEdit} timezone={timezone} back={back} />)}</ul> : null}
    </details>
  );
}
