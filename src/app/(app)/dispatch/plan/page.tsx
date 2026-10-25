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
import { getOptimizationPlan, getUpcomingOpenLoadDays } from "@/server/data/optimization";
import { businessToday } from "@/server/data/settings";

export const metadata = { title: "Plan the day" };

type Search = { date?: string; preset?: string; back?: string } & Partial<Record<(typeof PRIORITY_KEYS)[number], string>>;

export default async function PlanTheDayPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePagePermission("dispatch.view");
  const params = await searchParams;
  const { today, timezone } = await businessToday();
  const date = params.date && isIsoDate(params.date) && params.date >= today && params.date <= addDays(today, 14) ? params.date : addDays(today, 1);
  // A day outside today … 14 days ahead (an old link, a typed URL) is replaced by tomorrow — and the page says so.
  const dateReplaced = Boolean(params.date) && params.date !== date;
  const preset = params.preset && params.preset in PRESETS ? params.preset : PRIORITY_KEYS.some((k) => params[k] !== undefined) ? null : "balanced";
  const priorities = parsePriorities(params, PRESETS[preset ?? "balanced"].priorities);
  const [plan, gate] = await Promise.all([
    getOptimizationPlan(date, priorities, preset).catch((e: unknown) => {
      // The details stay in the server log; the dispatcher gets a plain message (no table or query names).
      console.error("Plan the day failed", e);
      return { error: "The plan could not be built right now. Nothing was changed; try again in a moment, or use the Dispatch board." };
    }),
    capabilityGate("plan_explanation", access),
  ]);
  // Empty day: point to the days that do have open loads instead of a dead end.
  const upcoming = !("error" in plan) && plan.input.loads.length === 0
    ? await getUpcomingOpenLoadDays(today, addDays(today, 14)).then((d) => d.filter((x) => x.date !== date)).catch(() => null)
    : [];
  const ai = { state: gate.state, label: GATE_LABELS[gate.state], canRun: gate.canRun, reasons: can(access, "settings.manage") ? gate.reasons : null };

  return (
    <>
      <ReturnLink back={params.back ?? "/dispatch"} />
      <PageHeader
        title="Plan the day"
        description={`${formatDateLong(date)}. Taviron proposes an assignment for every open load, checking hard rules first. Nothing is assigned until you approve it.`}
      />
      <form method="get" className="mb-5 rounded-panel border border-line/70 bg-card shadow-card px-4 py-3" aria-label="Plan settings">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <label className="text-sm">
            <span className="mb-1 block font-semibold text-ink">Day</span>
            <DateInput name="date" defaultValue={date} min={today} max={addDays(today, 14)} />
          </label>
          <fieldset className="text-sm">
            <legend className="mb-1 font-semibold text-ink">Planning mode</legend>
            {/* Each mode reloads the plan for the chosen day with that preset's priorities. */}
            <div className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-surface p-1">
              {Object.entries(PRESETS).map(([key, p]) => (
                <button key={key} name="preset" value={key} aria-pressed={preset === key}
                  className={`h-8 rounded px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand ${preset === key ? "bg-strong text-white" : "text-muted hover:bg-card hover:text-ink"}`}>
                  {p.label}
                </button>
              ))}
            </div>
          </fieldset>
          {/* Changing the day keeps the current preset or custom priorities. */}
          <button name="preset" value={preset ?? ""} className="h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            Show plan
          </button>
        </div>
        <details className="mt-3 border-t border-line pt-3" open={preset === null}>
          <summary className="cursor-pointer text-sm font-semibold text-ink">Adjust priorities{preset === null ? " · custom" : ""}</summary>
          <p className="mt-1 text-xs text-muted">0 = ignore, 5 = most important. Priorities rank feasible options only: safety, legal, qualification, capacity and maintenance rules always come first.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {PRIORITY_KEYS.map((k) => (
              <label key={k} className="text-sm">
                <span className="flex justify-between font-medium text-ink">{PRIORITY_LABELS[k]} <span className="tabular text-muted">{priorities[k]}</span></span>
                <input type="range" name={k} min={0} max={5} step={1} defaultValue={priorities[k]} className="mt-1 w-full accent-brand" />
              </label>
            ))}
          </div>
          <button className="mt-3 h-10 rounded-xl bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-dark">
            <Sparkles className="mr-1.5 inline size-4" aria-hidden />Plan with these priorities
          </button>
        </details>
      </form>
      {dateReplaced && (
        <p role="status" className="mb-4 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink">
          Plans cover today through 14 days ahead, so this shows {formatDateLong(date)} instead of the day in the link.
        </p>
      )}
      {"error" in plan ? (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">{plan.error}</p>
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
          explanations={plan.explanations}
          unavailable={plan.unavailable}
          upcoming={upcoming}
          preset={preset}
          priorities={{ ...priorities }}
        />
      )}
    </>
  );
}
