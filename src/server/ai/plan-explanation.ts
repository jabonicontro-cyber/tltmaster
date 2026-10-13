import "server-only";
import { z } from "zod";
import { capability } from "@/lib/ai/capabilities";
import {
  EXPLANATION_JSON_SCHEMA, PLAN_EXPLANATION_INSTRUCTIONS, checkExplanation, type Explanation, type PlanFacts, type Pseudonyms,
} from "@/lib/ai/plan-explanation";
import { PRIORITY_KEYS } from "@/lib/optimization/plan";
import type { CapabilityRequest } from "./run";
import type { Tool } from "./tools";

// "Explain this plan" as a capability request: facts, tools and validation (docs/AI.md §7).

export interface PlanToolData {
  pseudonyms: Pseudonyms;
}

const loadArg = z.object({ load: z.string().regex(/^L\d{1,4}$/) }).strict();
const weight = z.number().int().min(0).max(5);
const prioritiesArg = z.object({ service: weight, revenue: weight, utilization: weight, efficiency: weight, balance: weight, crews: weight, reason: z.string().min(1).max(240) }).strict();

export const PLAN_TOOLS: Tool<PlanToolData>[] = [
  {
    name: "get_load_details",
    description: "Details of one load in this plan by its code (L1, L2, …): customer and site codes, quantity, unit, requested date, urgency and time window.",
    kind: "read",
    permission: "dispatch.view",
    parameters: { type: "object", properties: { load: { type: "string" } }, required: ["load"], additionalProperties: false },
    args: loadArg as z.ZodType<unknown>,
    // Only loads of the plan the server computed for the caller's own company can be resolved; any other code or a
    // raw id (for example another company's load) is unknown here.
    run: (args, ctx) => ctx.data.pseudonyms.details[(args as z.infer<typeof loadArg>).load] ?? { error: "No such load in this plan." },
  },
  {
    name: "propose_priorities",
    description: "Suggest different priority weights (0–5 each) with a one-sentence reason. Only a suggestion: the dispatcher decides whether to try it.",
    kind: "propose",
    permission: "dispatch.view",
    parameters: {
      type: "object",
      properties: { ...Object.fromEntries(PRIORITY_KEYS.map((k) => [k, { type: "integer" }])), reason: { type: "string" } },
      required: [...PRIORITY_KEYS, "reason"],
      additionalProperties: false,
    },
    args: prioritiesArg as z.ZodType<unknown>,
    run: () => ({ status: "suggested", note: "Shown to the dispatcher as a suggestion. Nothing changed." }),
  },
];

export function planExplanationRequest(facts: PlanFacts, pseudonyms: Pseudonyms): CapabilityRequest<PlanToolData, Explanation> {
  return {
    capability: capability("plan_explanation"),
    instructions: PLAN_EXPLANATION_INSTRUCTIONS,
    input: JSON.stringify({ facts }),
    output: { name: "plan_explanation", schema: EXPLANATION_JSON_SCHEMA },
    tools: PLAN_TOOLS,
    secrets: pseudonyms.secrets,
    maxOutputTokens: 700,
    validate: (raw) => {
      const findings = checkExplanation(facts, raw, pseudonyms.secrets);
      return findings.length ? { ok: false, detail: findings.map((f) => f.detail).join(" ") } : { ok: true, value: raw as Explanation };
    },
  };
}
