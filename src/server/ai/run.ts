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

export interface UsageSummary {
  /** The caller's company. */
  tokensThisMonth: number;
  callsLastMinute: number;
  /** Estimated from the configured prices (millionths of a US dollar); calls without a price add nothing. */
  costThisMonthMicroUsd: number;
  /** The caller themself. */
  user: { tokensThisMonth: number; callsLastMinute: number; callsToday: number };
  /** The platform owner's pause switch: nothing is sent while it is on. */
  paused: boolean;
}

/** Why a reservation was refused (public.ai_reserve_call), or "unavailable" when it could not be made. */
export type ReserveRefusal = "paused" | "user_per_minute" | "user_daily" | "user_tokens" | "company_per_minute" | "company_tokens" | "company_cost" | "unavailable";

export interface ReserveRequest {
  requestKey: string;
  capability: string;
  provider: string;
  model: string;
  /** Projected tokens for this call (input estimate plus the output cap); held until the call is recorded. */
  tokens: number;
  settings: RunSettings;
}

export interface UsageLedger {
  /** null when the ledger or the per-person limits are unavailable: then nothing is sent. */
  summary(): Promise<UsageSummary | null>;
  /**
   * Atomically checks every limit against recorded usage plus calls in flight and reserves this call (one
   * reservation at a time per company). Without a reservation nothing is sent.
   */
  reserve(r: ReserveRequest): Promise<{ ok: true } | { ok: false; reason: ReserveRefusal }>;
  /** Finalizes the reservation with the same request key (reported tokens, cost, outcome). */
  record(event: UsageRecord): Promise<void>;
}

const REFUSED: Record<ReserveRefusal, AiError> = {
  paused: new AiError("disabled", "AI is paused by the platform owner."),
  user_per_minute: new AiError("user_limit", "You have asked several questions in the last minute. Try again shortly."),
  user_daily: new AiError("user_limit", "You have reached today's limit of AI requests."),
  user_tokens: new AiError("user_limit", "Your own AI token limit for this month would be exceeded."),
  company_per_minute: new AiError("rate_limit", "Too many AI requests in the last minute for this company. Try again shortly."),
  company_tokens: new AiError("budget", "This month's AI token limit would be exceeded."),
  company_cost: new AiError("budget", "This month's estimated AI cost limit is reached."),
  unavailable: new AiError("not_configured", "AI usage cannot be tracked right now, so nothing was sent."),
};

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
  /** Per company. */
  monthlyTokenLimit: number;
  requestsPerMinute: number;
  timeoutMs: number;
  pricing: Record<string, { inputPerMillion: number; outputPerMillion: number }>;
  /** Per person. */
  userMonthlyTokenLimit: number;
  userRequestsPerMinute: number;
  userDailyRequests: number;
  /** Per company, estimated; null: no cost ceiling (the token limits still apply). */
  monthlyCostLimitMicroUsd: number | null;
  /** Largest request sent to the provider, in characters (instructions, input, tool results). */
  maxRequestChars: number;
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
  const s = deps.settings;
  if (!usage) throw new AiError("not_configured", "AI usage cannot be tracked right now, so nothing was sent.");
  if (usage.paused) throw new AiError("disabled", "AI is paused by the platform owner.");
  if (!(s.userMonthlyTokenLimit > 0) || !(s.monthlyTokenLimit > 0)) throw new AiError("not_configured", "AI limits are not set, so nothing was sent.");
  if (usage.user.callsLastMinute >= s.userRequestsPerMinute) throw new AiError("user_limit", "You have asked several questions in the last minute. Try again shortly.");
  if (usage.user.callsToday >= s.userDailyRequests) throw new AiError("user_limit", "You have reached today's limit of AI requests.");
  if (usage.callsLastMinute >= s.requestsPerMinute) throw new AiError("rate_limit", "Too many AI requests in the last minute for this company. Try again shortly.");
  if (s.monthlyCostLimitMicroUsd !== null && usage.costThisMonthMicroUsd >= s.monthlyCostLimitMicroUsd) throw new AiError("budget", "This month's estimated AI cost limit is reached.");
  const projected = Math.ceil((req.instructions.length + req.input.length) / 3) + outputTokenCap(deps.gate.model, req.maxOutputTokens);
  if (usage.tokensThisMonth + projected > s.monthlyTokenLimit) throw new AiError("budget", "This month's AI token limit would be exceeded.");
  if (usage.user.tokensThisMonth + projected > s.userMonthlyTokenLimit) throw new AiError("user_limit", "Your own AI token limit for this month would be exceeded.");

  const used = { company: usage.tokensThisMonth, user: usage.user.tokensThisMonth };
  try {
    return await attempt(req, deps, deps.gate.model, false, used);
  } catch (e) {
    // Approved-only fallback: a second model is tried once, only for availability failures, and only when the gate
    // found passing evaluation evidence for it. Invalid answers, refusals, auth, budget and tool errors never fall back.
    if (e instanceof AiError && ["rate_limit", "timeout", "provider"].includes(e.kind) && deps.gate.fallbackModel) {
      return attempt(req, deps, deps.gate.fallbackModel, true, used);
    }
    throw e;
  }
}

async function attempt<C, O>(req: CapabilityRequest<C, O>, deps: RunDeps<C>, model: string, usedFallback: boolean, usedBefore: { company: number; user: number }): Promise<RunResult<O>> {
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
    const payload = JSON.stringify(request);
    const leak = findSensitive(payload, req.secrets);
    if (leak) throw new AiError("sensitive_data", `The request would have sent ${leak}; nothing was sent.`);
    if (payload.length > deps.settings.maxRequestChars) throw new AiError("too_large", "The question needs more data than one AI request may carry. Ask about a shorter period or one record.");
    const next = spent + outputTokenCap(model, req.maxOutputTokens);
    if (usedBefore.company + next > deps.settings.monthlyTokenLimit) throw new AiError("budget", "This month's AI token limit would be exceeded.");
    if (usedBefore.user + next > deps.settings.userMonthlyTokenLimit) throw new AiError("user_limit", "Your own AI token limit for this month would be exceeded.");

    // The atomic check: every limit again, counting calls still in flight (another request of this company or person).
    const callKey = key();
    const reservation = await deps.ledger.reserve({
      requestKey: callKey, capability: req.capability.id, provider: deps.provider.name, model,
      tokens: Math.ceil(payload.length / 3) + outputTokenCap(model, req.maxOutputTokens), settings: deps.settings,
    }).catch(() => ({ ok: false as const, reason: "unavailable" as const }));
    if (!reservation.ok) throw REFUSED[reservation.reason];

    const t0 = clock();
    let res: CompletionResponse;
    try {
      res = await deps.provider.complete(request, { timeoutMs: deps.settings.timeoutMs });
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError("provider", "The AI provider failed.");
      await deps.ledger.record({ requestKey: callKey, capability: req.capability.id, provider: deps.provider.name, model, outcome: "error", errorKind: err.kind, inputTokens: null, outputTokens: null, estimatedCostMicroUsd: null, latencyMs: clock() - t0 });
      throw err;
    }
    const callCost = estimateCostMicroUsd(model, res.usage, deps.settings.pricing);
    inTokens = inTokens === null || res.usage.inputTokens === null ? null : inTokens + res.usage.inputTokens;
    outTokens = outTokens === null || res.usage.outputTokens === null ? null : outTokens + res.usage.outputTokens;
    cost = cost === null || callCost === null ? null : cost + callCost;
    spent += (res.usage.inputTokens ?? 0) + (res.usage.outputTokens ?? 0);

    const finish = async (errorKind: AiErrorKind | null) =>
      deps.ledger.record({ requestKey: callKey, capability: req.capability.id, provider: deps.provider.name, model, outcome: errorKind ? "error" : "ok", errorKind, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, estimatedCostMicroUsd: callCost, latencyMs: clock() - t0 });

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
