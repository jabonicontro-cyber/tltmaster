import "server-only";
import { AI_CAPABILITIES, capability, evaluateGate, type AiCapabilityId, type Gate } from "@/lib/ai/capabilities";
import { EVAL_EVIDENCE } from "@/lib/ai/evidence";
import type { Access } from "@/lib/permissions";
import { createClient } from "@/server/supabase/server";
import { aiConfig, type AiConfig } from "./config";
import { OpenAiProvider } from "./openai";
import type { UsageLedger } from "./run";
import type { AiProvider } from "./types";

// Server wiring for AI capabilities: provider, usage ledger and readiness gates for the signed-in person (docs/AI.md).

export function provider(config: AiConfig = aiConfig()): AiProvider | null {
  if (config.provider === "openai" && config.apiKey) return new OpenAiProvider(config.apiKey);
  return null;
}

/** The usage ledger through the caller's own session; the database takes company and user from the session. */
export async function sessionLedger(): Promise<UsageLedger> {
  const db = await createClient();
  return {
    async summary() {
      const { data, error } = await db.rpc("ai_usage_summary");
      const row = (Array.isArray(data) ? data[0] : data) as { tokens_this_month: number | string; calls_last_minute: number } | null;
      if (error || !row) return null; // migration not applied or unreadable: nothing is sent
      return { tokensThisMonth: Number(row.tokens_this_month), callsLastMinute: Number(row.calls_last_minute) };
    },
    async record(e) {
      const { error } = await db.rpc("record_ai_usage", {
        p_request_key: e.requestKey, p_capability: e.capability, p_provider: e.provider, p_model: e.model, p_outcome: e.outcome,
        p_error_kind: e.errorKind, p_input_tokens: e.inputTokens, p_output_tokens: e.outputTokens,
        p_estimated_cost_micro_usd: e.estimatedCostMicroUsd, p_latency_ms: e.latencyMs,
      });
      if (error) console.error(`AI usage could not be recorded (${e.capability}): ${error.message}`);
    },
  };
}

/** The gate for one capability and person. Demo companies are Blocked unless AI_IN_DEMOS=on (DEMO_TENANTS §2). */
export async function capabilityGate(id: AiCapabilityId, access: Pick<Access, "permissions" | "isDemo">, ledger?: UsageLedger, config: AiConfig = aiConfig()): Promise<Gate> {
  const summary = await (ledger ?? (await sessionLedger())).summary().catch(() => null);
  const p = provider(config);
  return evaluateGate({
    capability: capability(id),
    config: {
      provider: config.provider,
      hasKey: Boolean(config.apiKey),
      providerSupportsStructuredOutput: p?.capabilities.structuredOutputs ?? false,
      enabled: config.enabled.includes(id),
      model: config.models[id] ?? null,
      fallbackModel: config.fallbackModels[id] ?? null,
      monthlyTokenLimit: config.monthlyTokenLimit,
      priced: (m) => m in config.pricing,
      inDemos: config.inDemos,
      invalid: config.invalid,
    },
    evidence: EVAL_EVIDENCE,
    usage: summary ? { tokensThisMonth: summary.tokensThisMonth } : null,
    isDemo: Boolean(access.isDemo),
    permissions: access.permissions,
    now: new Date(),
  });
}

export async function allCapabilityGates(access: Pick<Access, "permissions" | "isDemo">) {
  const ledger = await sessionLedger();
  return Promise.all(AI_CAPABILITIES.map(async (c) => ({ capability: c, gate: await capabilityGate(c.id, access, ledger) })));
}
