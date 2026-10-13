import type { Permission } from "@/lib/permissions";

// AI capabilities and their readiness gates (docs/AI.md §4). Pure: no environment, network or database access, so the
// same rules decide what the server runs and what the setup page shows. A capability runs only when its gate is Ready
// or Limited; Needs review and Blocked never call a model.

export type AiCapabilityId = "plan_explanation";

export interface AiCapability {
  id: AiCapabilityId;
  label: string;
  description: string;
  /** Who may use it; checked on the server from the session, never from the request. */
  permission: Permission;
  /** What the capability may do with its tools. Nothing in this increment executes a consequential action. */
  maxToolKind: "read" | "propose";
  /** Version of the evaluation set; evidence for an older version does not count. */
  evalVersion: number;
  /** Share of evaluation cases that must pass (critical failures — invented figures, forbidden claims — fail outright). */
  minPassRate: number;
  /** Evidence older than this needs a new run (models and prompts drift). */
  evidenceMaxAgeDays: number;
  needsStructuredOutput: boolean;
}

export const AI_CAPABILITIES: AiCapability[] = [
  {
    id: "plan_explanation",
    label: "Explain this plan",
    description: "A short plain-language summary of a Plan the day result: what it covers, what it leaves open and what a dispatcher should check. Uses only the figures Taviron computed; it never changes the plan or assigns anything.",
    permission: "dispatch.view",
    maxToolKind: "propose",
    evalVersion: 1,
    minPassRate: 0.9,
    evidenceMaxAgeDays: 90,
    needsStructuredOutput: true,
  },
];

export function capability(id: AiCapabilityId): AiCapability {
  const c = AI_CAPABILITIES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown AI capability ${id}`);
  return c;
}

/** The result of an evaluation run against one model (src/lib/ai/evidence.ts). Recorded, never invented. */
export interface EvalEvidence {
  capability: AiCapabilityId;
  provider: string;
  model: string;
  evalVersion: number;
  /** ISO date the run finished. */
  ranAt: string;
  cases: number;
  passed: number;
  /** Invented figures, forbidden claims, leaked names. Any critical failure fails the run. */
  criticalFailures: number;
}

export type GateState = "ready" | "limited" | "needs_review" | "blocked";

export const GATE_LABELS: Record<GateState, string> = {
  ready: "Ready",
  limited: "Limited",
  needs_review: "Needs review",
  blocked: "Blocked",
};

export interface GateInput {
  capability: AiCapability;
  config: {
    provider: string | null;
    hasKey: boolean;
    providerSupportsStructuredOutput: boolean;
    enabled: boolean;
    model: string | null;
    fallbackModel: string | null;
    monthlyTokenLimit: number | null;
    priced: (model: string) => boolean;
    inDemos: boolean;
    invalid: string[];
  };
  evidence: EvalEvidence[];
  /** null when the usage ledger is not available (migration not applied, or it could not be read). */
  usage: { tokensThisMonth: number } | null;
  isDemo: boolean;
  permissions: readonly string[];
  now: Date;
}

export interface Gate {
  state: GateState;
  /** Plain-language reasons, worst first. Never contains a key or other secret. */
  reasons: string[];
  model: string | null;
  /** The approved fallback, only when it has its own passing evidence. */
  fallbackModel: string | null;
  canRun: boolean;
}

/** Why a model's evidence does not count yet; null when it passes. */
export function evidenceProblem(c: AiCapability, provider: string, model: string, evidence: EvalEvidence[], now: Date): string | null {
  const runs = evidence
    .filter((e) => e.capability === c.id && e.provider === provider && e.model === model)
    .sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  const latest = runs[0];
  if (!latest) return `No evaluation has been run for ${model}.`;
  if (latest.evalVersion !== c.evalVersion) return `The last evaluation of ${model} used an older test set (version ${latest.evalVersion}; current ${c.evalVersion}).`;
  const age = (now.getTime() - new Date(latest.ranAt).getTime()) / 86_400_000;
  if (!(age <= c.evidenceMaxAgeDays)) return `The last evaluation of ${model} is older than ${c.evidenceMaxAgeDays} days.`;
  if (latest.criticalFailures > 0) return `The last evaluation of ${model} had ${latest.criticalFailures} critical failure(s).`;
  if (latest.cases === 0 || latest.passed / latest.cases < c.minPassRate) return `The last evaluation of ${model} passed ${latest.passed} of ${latest.cases} cases (needs ${Math.round(c.minPassRate * 100)}%).`;
  return null;
}

export function evaluateGate(input: GateInput): Gate {
  const { capability: c, config } = input;
  const blocked: string[] = [];
  const review: string[] = [];
  const limited: string[] = [];

  if (!input.permissions.includes(c.permission)) blocked.push("You do not have permission to use this.");
  if (!config.provider) blocked.push("No AI provider is configured.");
  else if (!config.hasKey) blocked.push("The provider's API key is not set on the server.");
  if (config.invalid.length) blocked.push(`Some AI settings are malformed and ignored: ${config.invalid.join(", ")}.`);
  if (!config.enabled) blocked.push("This capability is not switched on (AI_CAPABILITIES).");
  if (!config.model) blocked.push("No model is chosen for this capability.");
  if (c.needsStructuredOutput && config.provider && !config.providerSupportsStructuredOutput) blocked.push("The provider does not support structured output.");
  if (!config.monthlyTokenLimit) blocked.push("No monthly token limit is set (AI_MONTHLY_TOKEN_LIMIT).");
  if (input.usage === null) blocked.push("The AI usage ledger is not available, so usage could not be tracked.");
  if (input.isDemo && !config.inDemos) blocked.push("AI is not turned on in demo companies.");
  if (input.usage && config.monthlyTokenLimit && input.usage.tokensThisMonth >= config.monthlyTokenLimit) blocked.push("This month's AI token limit is used up.");

  let fallbackModel: string | null = null;
  if (config.provider && config.model) {
    const problem = evidenceProblem(c, config.provider, config.model, input.evidence, input.now);
    if (problem) review.push(problem);
    if (config.fallbackModel && config.fallbackModel !== config.model) {
      if (!evidenceProblem(c, config.provider, config.fallbackModel, input.evidence, input.now)) fallbackModel = config.fallbackModel;
      else limited.push(`The fallback model ${config.fallbackModel} has no passing evaluation and will not be used.`);
    }
    if (!config.priced(config.model)) limited.push("No price is configured for this model, so costs are not estimated (tokens are still counted).");
  }
  if (input.usage && config.monthlyTokenLimit && input.usage.tokensThisMonth >= 0.8 * config.monthlyTokenLimit && input.usage.tokensThisMonth < config.monthlyTokenLimit) {
    limited.push(`${Math.round((input.usage.tokensThisMonth / config.monthlyTokenLimit) * 100)}% of this month's AI token limit is used.`);
  }

  const state: GateState = blocked.length ? "blocked" : review.length ? "needs_review" : limited.length ? "limited" : "ready";
  return {
    state,
    reasons: [...blocked, ...review, ...limited],
    model: config.model,
    fallbackModel: state === "ready" || state === "limited" ? fallbackModel : null,
    canRun: state === "ready" || state === "limited",
  };
}
