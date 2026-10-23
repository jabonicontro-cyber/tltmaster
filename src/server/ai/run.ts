import "server-only";
import type { AiCapability, Gate } from "@/lib/ai/capabilities";
import { runToolCall, toolDefinitions, type PendingApproval, type Proposal, type Tool, type ToolContext } from "./tools";
import { AiError, type AiErrorKind, type AiProvider, type CompletionResponse, type ConversationItem, type JsonSchema } from "./types";
import { outputTokenCap } from "@/lib/ai/reasoning";

// Runs one AI capability request (docs/AI.md §2): gate → budget and rate limit → provider calls with approved tools →
// validation → result. Every provider call is recorded in the usage ledger, success or failure. Nothing here can
// assign, send, pay or change a record: tools are read or propose only, and execute tools become pending approvals.

export const MAX_ROUNDS = 3;
const MAX_REFUSALS = 3;

export interface UsageRecord {
  requestKey: string;
  capability: string;
  provider: string;
  model: string;
  outcome: "ok" | "error";
  errorKind: AiErrorKind | null;
  /** As reported by the provider; null when not reported. Never estimated. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Estimate from the configured price table (millionths of a US dollar); null without a price or reported usage. */
  estimatedCostMicroUsd: number | null;
  latencyMs: number;
}

export interface UsageLedger {
  /** null when the ledger is unavailable: then nothing is sent. */
  summary(): Promise<{ tokensThisMonth: number; callsLastMinute: number } | null>;
  record(event: UsageRecord): Promise<void>;
}

export interface CapabilityRequest<C, O> {
  capability: AiCapability;
  instructions: string;
  input: string;
  output: { name: string; schema: JsonSchema };
  tools: Tool<C>[];
  /** Validates the parsed answer (schema, grounding, forbidden claims). */
  validate: (raw: unknown) => { ok: true; value: O } | { ok: false; detail: string };
  /** Real values that must never be sent to the provider (names, numbers replaced by codes). */
  secrets: string[];
  maxOutputTokens: number;
}

export interface RunSettings {
  monthlyTokenLimit: number;
  requestsPerMinute: number;
  timeoutMs: number;
  pricing: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
}

export interface RunResult<O> {
  value: O;
  model: string;
  usedFallback: boolean;
  /** Totals reported by the provider (null if any call did not report). */
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** Estimate in US dollars from the configured prices; null when not priced. Labelled as an estimate wherever shown. */
  estimatedCostUsd: number | null;
  latencyMs: number;
  calls: number;
  proposals: Proposal[];
  pendingApprovals: PendingApproval[];
}

export interface RunDeps<C> {
  provider: AiProvider;
  ledger: UsageLedger;
  settings: RunSettings;
  gate: Gate;
  toolContext: ToolContext<C>;
  requestKey?: () => string;
  clock?: () => number;
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** What must never leave the server: listed real values, email addresses and record ids. */
export function findSensitive(payload: string, secrets: string[]): string | null {
  const lower = payload.toLowerCase();
  if (secrets.some((s) => s.trim().length >= 3 && lower.includes(s.trim().toLowerCase()))) return "a real name or number";
  if (EMAIL.test(payload)) return "an email address";
  if (UUID.test(payload)) return "a record id";
  return null;
}

export function estimateCostMicroUsd(model: string, usage: CompletionResponse["usage"], pricing: RunSettings["pricing"]): number | null {
  const price = pricing[model];
  if (!price || usage.inputTokens === null || usage.outputTokens === null) return null;
  // USD per million tokens × tokens = micro-USD.
  return Math.round(usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion);
}

export async function runCapability<C, O>(req: CapabilityRequest<C, O>, deps: RunDeps<C>): Promise<RunResult<O>> {
  if (!deps.gate.canRun || !deps.gate.model) throw new AiError("disabled", deps.gate.reasons[0] ?? "This AI capability is not available.");
  const usage = await deps.ledger.summary();
  if (!usage) throw new AiError("not_configured", "AI usage cannot be tracked right now, so nothing was sent.");
  if (usage.callsLastMinute >= deps.settings.requestsPerMinute) throw new AiError("rate_limit", "Too many AI requests in the last minute for this company. Try again shortly.");
  const projected = Math.ceil((req.instructions.length + req.input.length) / 3) + outputTokenCap(deps.gate.model, req.maxOutputTokens);
  if (usage.tokensThisMonth + projected > deps.settings.monthlyTokenLimit) throw new AiError("budget", "This month's AI token limit would be exceeded.");

  try {
    return await attempt(req, deps, deps.gate.model, false, usage.tokensThisMonth);
  } catch (e) {
    // Approved-only fallback: a second model is tried once, only for availability failures, and only when the gate
    // found passing evaluation evidence for it. Invalid answers, refusals, auth, budget and tool errors never fall back.
    if (e instanceof AiError && ["rate_limit", "timeout", "provider"].includes(e.kind) && deps.gate.fallbackModel) {
      return attempt(req, deps, deps.gate.fallbackModel, true, usage.tokensThisMonth);
    }
    throw e;
  }
}

async function attempt<C, O>(req: CapabilityRequest<C, O>, deps: RunDeps<C>, model: string, usedFallback: boolean, usedBefore: number): Promise<RunResult<O>> {
  const clock = deps.clock ?? Date.now;
  const key = deps.requestKey ?? (() => crypto.randomUUID());
  const items: ConversationItem[] = [{ kind: "message", role: "user", text: req.input }];
  const proposals: Proposal[] = [];
  const pendingApprovals: PendingApproval[] = [];
  let inTokens: number | null = 0;
  let outTokens: number | null = 0;
  let cost: number | null = 0;
  let refusals = 0;
  let spent = 0;
  const started = clock();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const request = {
      model,
      instructions: req.instructions,
      input: items,
      tools: req.tools.length ? toolDefinitions(req.tools) : undefined,
      output: req.output,
      maxOutputTokens: req.maxOutputTokens,
    };
    const leak = findSensitive(JSON.stringify(request), req.secrets);
    if (leak) throw new AiError("sensitive_data", `The request would have sent ${leak}; nothing was sent.`);
    if (usedBefore + spent + outputTokenCap(model, req.maxOutputTokens) > deps.settings.monthlyTokenLimit) throw new AiError("budget", "This month's AI token limit would be exceeded.");

    const t0 = clock();
    let res: CompletionResponse;
    try {
      res = await deps.provider.complete(request, { timeoutMs: deps.settings.timeoutMs });
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError("provider", "The AI provider failed.");
      await deps.ledger.record({ requestKey: key(), capability: req.capability.id, provider: deps.provider.name, model, outcome: "error", errorKind: err.kind, inputTokens: null, outputTokens: null, estimatedCostMicroUsd: null, latencyMs: clock() - t0 });
      throw err;
    }
    const callCost = estimateCostMicroUsd(model, res.usage, deps.settings.pricing);
    inTokens = inTokens === null || res.usage.inputTokens === null ? null : inTokens + res.usage.inputTokens;
    outTokens = outTokens === null || res.usage.outputTokens === null ? null : outTokens + res.usage.outputTokens;
    cost = cost === null || callCost === null ? null : cost + callCost;
    spent += (res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0);

    const finish = async (errorKind: AiErrorKind | null) =>
      deps.ledger.record({ requestKey: key(), capability: req.capability.id, provider: deps.provider.name, model, outcome: errorKind ? "error" : "ok", errorKind, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, estimatedCostMicroUsd: callCost, latencyMs: clock() - t0 });

    if (res.refusal) {
      await finish("invalid_output");
      throw new AiError("invalid_output", "The model declined to answer.");
    }

    if (res.toolCalls.length) {
      await finish(null);
      for (const call of res.toolCalls) {
        const outcome = await runToolCall(req.tools, call, deps.toolContext, req.capability.maxToolKind);
        if (outcome.status === "refused") refusals++;
        if (outcome.status === "ok" && outcome.proposal) proposals.push(outcome.proposal);
        if (outcome.status === "needs_approval") pendingApprovals.push(outcome.pending);
        items.push({ kind: "tool_call", callId: call.callId, name: call.name, arguments: call.arguments });
        items.push({ kind: "tool_result", callId: call.callId, output: outcome.output });
      }
      if (refusals >= MAX_REFUSALS) throw new AiError("tool", "The model kept asking for tools it may not use.");
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(res.text ?? "");
    } catch {
      await finish("invalid_output");
      throw new AiError("invalid_output", "The answer was not valid JSON.");
    }
    const checked = req.validate(raw);
    if (!checked.ok) {
      await finish("invalid_output");
      throw new AiError("invalid_output", `The answer did not pass Taviron's checks: ${checked.detail}`);
    }
    await finish(null);
    return {
      value: checked.value,
      model: res.model,
      usedFallback,
      usage: { inputTokens: inTokens, outputTokens: outTokens },
      estimatedCostUsd: cost === null ? null : cost / 1_000_000,
      latencyMs: clock() - started,
      calls: round,
      proposals,
      pendingApprovals,
    };
  }
  throw new AiError("invalid_output", `No final answer after ${MAX_ROUNDS} model calls.`);
}
