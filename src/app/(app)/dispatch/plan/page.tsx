import { Sparkles } from "lucide-react";
import { OptimizationPlanner } from "@/components/dispatch/optimization-planner";
import { DateInput } from "@/components/ui/date-input";
import { PageHeader } from "@/components/ui/page-header";
import { ReturnLink } from "@/components/ui/return-link";
import { addDays, formatDateLong, isIsoDate } from "@/lib/dates";
import { PRESETS, PRIORITY_KEYS, PRIORITY_LABELS, parsePriorities } from "@/lib/optimization/plan";
import { can } from "@/lib/permissions";
import { requirePagePermission } from "@/server/auth";
import { GATE_LABELS } from "@/lib/ai/capabilities";
import { capabilityGate } from "@/server/ai/gates";
import { getOptimizationPlan } from "@/server/data/optimization";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Plan the day" };

type Search = { date?: string; preset?: string; back?: string } & Partial<Record<(typeof PRIORITY_KEYS)[number], string>>;

export default async function PlanTheDayPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("dispatch.view");
  const params = await searchParams;
  const { today, timezone } = await businessToday();
  const date = params.date && isIsoDate(params.date) && params.date >= today && params.date <= addDays(today, 14) ? params.date : addDays(today, 1);
  const preset = params.preset && params.preset in PRESETS ? params.preset : PRIORITY_KEYS.some((k) => params[k] !== undefined) ? null : "balanced";
  const priorities = parsePriorities(params, PRESETS[preset ?? "balanced"].priorities);
  const [plan, gate] = await Promise.all([
    getOptimizationPlan(date, priorities, preset).catch((e: unknown) => ({ error: e instanceof Error ? e.message : "The optimizer is unavailable." })),
    capabilityGate("plan_explanation", access),
  ]);
  const ai = { state: gate.state, label: GATE_LABELS[gate.state], canRun: gate.canRun, reasons: can(access, "settings.manage") ? gate.reasons : null };

  return (
    <>
      <ReturnLink back={params.back ?? "/dispatch"} />
      <PageHeader
        title="Plan the day"
        description={`${formatDateLong(date)}. Taviron plans every unassigned load across your trucks and drivers at once, checks every hard rule first, and ranks the options by the priorities you choose. Nothing is assigned until you approve it.`}
      />
      <form method="get" className="mb-6 rounded-lg border border-line bg-card p-4" aria-label="Plan settings">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block font-semibold text-ink">Day</span>
            <DateInput name="date" defaultValue={date} min={today} max={addDays(today, 14)} />
          </label>
          <fieldset className="text-sm">
            <legend className="mb-1 font-semibold text-ink">Start from</legend>
            <div className="flex flex-wrap gap-2">
              {Object.entries(PRESETS).map(([key, p]) => (
                <button key={key} name="preset" value={key} className={`h-10 rounded-md border px-3 text-sm font-semibold ${preset === key ? "border-strong bg-surface text-ink" : "border-line text-muted hover:bg-surface"}`} aria-pressed={preset === key}>
                  {p.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <details className="mt-4" open={preset === null}>
          <summary className="cursor-pointer text-sm font-semibold text-ink">Adjust priorities (0 = ignore, 5 = most important)</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {PRIORITY_KEYS.map((k) => (
              <label key={k} className="text-sm">
                <span className="flex justify-between font-medium text-ink">{PRIORITY_LABELS[k]} <span className="tabular text-muted">{priorities[k]}</span></span>
                <input type="range" name={k} min={0} max={5} step={1} defaultValue={priorities[k]} className="mt-1 w-full accent-brand" aria-describedby="priority-note" />
              </label>
            ))}
          </div>
          <p id="priority-note" className="mt-2 text-xs text-muted">Priorities rank feasible options only. Safety, legal, qualification, capacity and maintenance rules always come first.</p>
          <button className="mt-3 h-10 rounded-md bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark">
            <Sparkles className="mr-1.5 inline size-4" aria-hidden />Plan with these priorities
          </button>
        </details>
      </form>
      {"error" in plan ? (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-gray-950">{plan.error}</p>
      ) : (
        <OptimizationPlanner
          key={`${date}|${JSON.stringify(priorities)}`}
          date={date}
          timezone={timezone}
          loads={plan.input.loads}
          revenueCents={plan.input.revenueCents}
          result={plan.result}
          canEdit={can(access, "dispatch.edit")}
          ai={ai}
          preset={preset}
          priorities={{ ...priorities }}
        />
      )}
    </>
  );
}
