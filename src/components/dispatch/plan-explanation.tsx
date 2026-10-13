"use client";

import Link from "next/link";
import { useState } from "react";
import { MessageSquareText } from "lucide-react";
import { explainPlan, type PlanExplanationView } from "@/app/(app)/dispatch/plan/actions";
import { Button } from "@/components/ui/button";
import type { GateState } from "@/lib/ai/capabilities";

export interface PlanAiState {
  state: GateState;
  label: string;
  canRun: boolean;
  /** Present for people who manage settings: the panel points them to Company setup, where the reasons are listed. */
  reasons: string[] | null;
}

/**
 * "Explain this plan" (docs/AI.md §7): an optional AI-written summary of the selected plan, produced on the server from
 * Taviron's own figures and checked against them before it is shown. Clearly labelled as AI-generated; it never changes
 * the plan. When the capability's gate is closed it says so instead of offering the button.
 */
export function PlanExplanation({ ai, date, preset, priorities, planKey, planLabel }: {
  ai: PlanAiState; date: string; preset: string | null; priorities: Record<string, number>; planKey: string; planLabel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<{ key: string; data: PlanExplanationView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = view?.key === planKey ? view.data : null;

  async function explain() {
    setBusy(true);
    setError(null);
    const r = await explainPlan({ date, preset, priorities: Object.fromEntries(Object.entries(priorities).map(([k, v]) => [k, String(v)])), planKey });
    setBusy(false);
    if (r.ok) setView({ key: planKey, data: r.data });
    else setError(r.error);
  }

  const suggestionHref = shown?.suggestion
    ? `/dispatch/plan?${new URLSearchParams({ date, ...Object.fromEntries(Object.entries(shown.suggestion.priorities).map(([k, v]) => [k, String(v)])) })}`
    : null;

  return (
    <section aria-labelledby="ai-explain-title" className="rounded-lg border border-line bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ai-explain-title" className="flex items-center gap-2 text-base font-bold text-ink">
          <MessageSquareText className="size-4" aria-hidden /> Explain this plan
        </h2>
        {ai.canRun ? (
          <Button variant="secondary" onClick={explain} loading={busy} disabled={busy}>{shown ? "Explain again" : `Explain ${planLabel}`}</Button>
        ) : (
          <span className="text-xs font-semibold text-muted">AI: {ai.label}</span>
        )}
      </div>
      {!ai.canRun && (
        <p className="mt-2 text-sm text-muted">
          AI explanations are not available for this company yet. The plan above is complete without them.
          {ai.reasons && ai.reasons.length > 0 && (
            <> Administrators can see what is missing in <Link href="/setup" className="font-semibold text-brand-fg hover:underline">Company setup</Link>.</>
          )}
        </p>
      )}
      {error && <p role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">{error}</p>}
      {shown && (
        <div className="mt-3 space-y-3 text-sm text-ink" aria-live="polite">
          <p className="text-xs font-semibold text-muted">AI-generated summary · checked against Taviron&apos;s figures · it does not change the plan</p>
          <p>{shown.summary}</p>
          {shown.highlights.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">{shown.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
          )}
          {shown.checks.length > 0 && (
            <div>
              <h3 className="font-semibold">Check before approving</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5">{shown.checks.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}
          {shown.loadsToReview.length > 0 && <p><span className="font-semibold">Loads to review:</span> {shown.loadsToReview.join(", ")}</p>}
          {shown.suggestion && suggestionHref && (
            <p>
              <span className="font-semibold">Suggested priorities:</span> {shown.suggestion.reason}{" "}
              <Link href={suggestionHref} className="font-semibold text-brand-fg hover:underline">Try them (nothing is assigned)</Link>
            </p>
          )}
          <p className="text-xs text-muted">
            Model {shown.model}{shown.usedFallback ? " (approved fallback)" : ""} · tokens reported: {shown.tokens.input ?? "?"} in / {shown.tokens.output ?? "?"} out
            {shown.estimatedCostUsd !== null ? ` · estimated cost $${shown.estimatedCostUsd.toFixed(4)}` : " · cost not estimated"}
          </p>
        </div>
      )}
    </section>
  );
}
