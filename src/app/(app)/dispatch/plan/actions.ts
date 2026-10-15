"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { buildPlanFacts, relabel } from "@/lib/ai/plan-explanation";
import { addDays, isIsoDate } from "@/lib/dates";
import { PRESETS, checkAssignment, parsePriorities } from "@/lib/optimization/plan";
import { aiConfig } from "@/server/ai/config";
import { capabilityGate, provider, sessionLedger } from "@/server/ai/gates";
import { planExplanationRequest } from "@/server/ai/plan-explanation";
import { runCapability } from "@/server/ai/run";
import { AiError } from "@/server/ai/types";
import { HOS_REQUIRED_MESSAGE, approvalNote, hosApprovalAllowed, hosProvider } from "@/lib/hos";
import { assertPermission } from "@/server/auth";
import { getOptimizationInput, getOptimizationPlan } from "@/server/data/optimization";
import { businessToday } from "@/server/data/settings";
import { dbErrorMessage, guard } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const approveInput = z.object({
  date: z.string().refine(isIsoDate),
  planLabel: z.string().trim().min(1).max(60),
  items: z.array(z.object({ loadId: z.uuid(), truckId: z.uuid(), trailerId: z.uuid().nullable(), driverId: z.uuid() })).min(1).max(100),
  hosConfirmed: z.boolean().default(false),
});

export interface ApprovalOutcome {
  loadId: string;
  assigned: boolean;
  message: string;
  warnings: string[];
}

/**
 * Approve selected assignments of an optimization plan. Each one is re-checked against the current data first
 * (someone may have assigned, rescheduled or taken a truck out of service since the plan was made), then assigned
 * through public.assign_load — the same permission, eligibility, capacity, trailer and conflict checks as any assignment.
 * One at a time, in order, so an earlier approval is part of the next re-check. Confirmed assignments are never
 * replaced (no replace id is ever passed), and nothing outside the selection is assigned.
 */
export async function approvePlanAssignments(input: z.input<typeof approveInput>): Promise<ActionResult<{ outcomes: ApprovalOutcome[] }>> {
  return guard(async () => {
    await assertPermission("dispatch.edit");
    const parsed = approveInput.safeParse(input);
    if (!parsed.success) return fail("Invalid plan selection.");
    const { date, planLabel, items, hosConfirmed } = parsed.data;
    // Hours of service are not in Taviron (lib/hos): the dispatcher confirms them, or nothing is assigned.
    if (!hosApprovalAllowed(hosProvider(), items.map((i) => i.driverId), date, hosConfirmed)) return fail(HOS_REQUIRED_MESSAGE);
    const supabase = await createClient();
    const outcomes: ApprovalOutcome[] = [];
    for (const item of items) {
      const check = checkAssignment(await getOptimizationInput(date), item.loadId, item.truckId, item.trailerId, item.driverId);
      if (!check.ok) {
        outcomes.push({ loadId: item.loadId, assigned: false, message: `Not assigned — no longer valid: ${check.reasons.join(" ")}`, warnings: [] });
        continue;
      }
      const { data, error } = await supabase.rpc("assign_load", {
        p_load_id: item.loadId, p_truck_id: item.truckId, p_trailer_id: item.trailerId, p_driver_id: item.driverId,
        p_note: approvalNote(`Approved optimization plan (${planLabel})`, hosConfirmed), p_replace_assignment_id: null,
      });
      outcomes.push(error
        ? { loadId: item.loadId, assigned: false, message: `Not assigned: ${dbErrorMessage(error)}`, warnings: [] }
        : { loadId: item.loadId, assigned: true, message: "Assigned.", warnings: ((data as { warnings?: string[] } | null)?.warnings ?? []) });
    }
    revalidatePath("/dispatch");
    revalidatePath("/dispatch/plan");
    revalidatePath("/command-center");
    const done = outcomes.filter((o) => o.assigned).length;
    return ok({ outcomes }, done === outcomes.length ? `${done} assignment(s) approved.` : `${done} of ${outcomes.length} approved; see the reasons for the rest.`);
  });
}

const explainInput = z.object({
  date: z.string().refine(isIsoDate),
  preset: z.string().max(30).nullable(),
  priorities: z.record(z.string(), z.string().max(2)),
  planKey: z.string().min(1).max(40),
});

export interface PlanExplanationView {
  summary: string;
  highlights: string[];
  checks: string[];
  loadsToReview: string[];
  /** Suggested priorities from the model (a suggestion only; applying them just re-plans). */
  suggestion: { priorities: Record<string, number>; reason: string } | null;
  model: string;
  usedFallback: boolean;
  tokens: { input: number | null; output: number | null };
  estimatedCostUsd: number | null;
}

/**
 * "Explain this plan" (docs/AI.md §7). The plan is recomputed here from the company's own data — numbers from the
 * browser are never trusted — then explained by the configured model under the capability's readiness gate. The model
 * sees codes instead of names; its answer must pass every grounding check before real labels are put back. Read-only:
 * it cannot assign, change or send anything. Failure leaves the deterministic plan exactly as it is.
 */
export async function explainPlan(input: z.input<typeof explainInput>): Promise<ActionResult<PlanExplanationView>> {
  return guard(async () => {
    const access = await assertPermission("dispatch.view");
    const parsed = explainInput.safeParse(input);
    if (!parsed.success) return fail("Invalid plan.");
    const { today } = await businessToday();
    const { date, planKey } = parsed.data;
    if (date < today || date > addDays(today, 14)) return fail("Choose a day within the next two weeks.");
    const preset = parsed.data.preset && parsed.data.preset in PRESETS ? parsed.data.preset : null;
    const priorities = parsePriorities(parsed.data.priorities, PRESETS[preset ?? "balanced"].priorities);

    const config = aiConfig();
    const ledger = await sessionLedger();
    const gate = await capabilityGate("plan_explanation", access, ledger, config);
    const ai = provider(config);
    if (!gate.canRun || !ai) return fail(`AI explanation is not available: ${gate.reasons[0] ?? "not configured"}`);

    const { input: optInput, result } = await getOptimizationPlan(date, priorities, preset);
    const plan = result.plans.find((p) => p.key === planKey);
    if (!plan) return fail("That plan is no longer available. Reload the page.");
    const { facts, pseudonyms } = buildPlanFacts(plan, optInput.loads, result.dataNotes, date, optInput.hoursOfServiceVerified === true);
    try {
      const run = await runCapability(planExplanationRequest(facts, pseudonyms), {
        provider: ai,
        ledger,
        gate,
        settings: { monthlyTokenLimit: config.monthlyTokenLimit!, requestsPerMinute: config.requestsPerMinute, timeoutMs: config.timeoutMs, pricing: config.pricing },
        toolContext: { permissions: access.permissions, data: { pseudonyms } },
      });
      const label = (t: string) => relabel(t, pseudonyms.labels);
      const proposed = run.proposals.find((p) => p.tool === "propose_priorities")?.args as (Record<string, number> & { reason: string }) | undefined;
      return ok<PlanExplanationView>({
        summary: label(run.value.summary),
        highlights: run.value.highlights.map(label),
        checks: run.value.checks.map(label),
        loadsToReview: run.value.loadsToReview.map(label),
        suggestion: proposed ? { priorities: Object.fromEntries(Object.entries(proposed).filter(([k]) => k !== "reason")) as Record<string, number>, reason: label(proposed.reason) } : null,
        model: run.model,
        usedFallback: run.usedFallback,
        tokens: { input: run.usage.inputTokens, output: run.usage.outputTokens },
        estimatedCostUsd: run.estimatedCostUsd,
      });
    } catch (e) {
      if (e instanceof AiError) return fail(`AI explanation unavailable: ${e.message} The plan itself is unchanged.`);
      throw e;
    }
  });
}
