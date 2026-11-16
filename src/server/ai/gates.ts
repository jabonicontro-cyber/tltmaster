import "server-only";
import { AI_CAPABILITIES, capability, evaluateGate, type AiCapabilityId, type Gate } from "@/lib/ai/capabilities";
import { EVAL_EVIDENCE } from "@/lib/ai/evidence";
import { noticeAccepted } from "@/lib/ai/notice";
import type { Access } from "@/lib/permissions";
import { createClient } from "@/server/supabase/server";
import { aiConfig, type AiConfig } from "./config";
import { OpenAiProvider } from "./openai";
import type { ReserveRefusal, UsageLedger } from "./run";
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
      // Company and person totals plus the platform pause switch (20261120002400). Without that migration nothing is
      // sent: per-person limits and the pause switch could not be checked (fail closed).
      const { data, error } = await db.rpc("ai_usage_limits");
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, number | string | boolean | null> | null;
      if (error || !row) return null;
      return {
        tokensThisMonth: Number(row.tokens_this_month),
        callsLastMinute: Number(row.calls_last_minute),
        costThisMonthMicroUsd: Number(row.cost_this_month_micro_usd),
        user: { tokensThisMonth: Number(row.user_tokens_this_month), callsLastMinute: Number(row.user_calls_last_minute), callsToday: Number(row.user_calls_today) },
        paused: row.paused !== false,
      };
    },
    async reserve(r) {
      // 20261120002500. Without it (or on any error) nothing is reserved, so nothing is sent (fail closed).
      const { data, error } = await db.rpc("ai_reserve_call", {
        p_request_key: r.requestKey, p_capability: r.capability, p_provider: r.provider, p_model: r.model, p_reserve_tokens: r.tokens,
        p_monthly_tokens: r.settings.monthlyTokenLimit, p_per_minute: r.settings.requestsPerMinute,
        p_monthly_cost_micro_usd: r.settings.monthlyCostLimitMicroUsd,
        p_user_monthly_tokens: r.settings.userMonthlyTokenLimit, p_user_per_minute: r.settings.userRequestsPerMinute, p_user_daily: r.settings.userDailyRequests,
      });
      if (error || typeof data !== "string") return { ok: false, reason: "unavailable" };
      if (data === "ok") return { ok: true };
      const known: ReserveRefusal[] = ["paused", "user_per_minute", "user_daily", "user_tokens", "company_per_minute", "company_tokens", "company_cost"];
      return { ok: false, reason: known.includes(data as ReserveRefusal) ? (data as ReserveRefusal) : "unavailable" };
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

export interface OptIn {
  companyAllowed: boolean;
  noticeAccepted: boolean;
}

/**
 * The company's choice (company_settings.ai_assistant_allowed) and this person's acknowledgement of the current
 * first-use notice (user_preferences 'ai_notice'), both read with the caller's own session, so row-level security keeps
 * them to the current company and person (20261120022000). null when they cannot be read: the gate is then Blocked.
 */
export async function sessionOptIn(access: Pick<Access, "companyId" | "userId">): Promise<OptIn | null> {
  if (!access.companyId) return null;
  const db = await createClient();
  const [company, notice] = await Promise.all([
    db.from("company_settings").select("ai_assistant_allowed").eq("company_id", access.companyId).maybeSingle(),
    db.from("user_preferences").select("value").eq("company_id", access.companyId).eq("user_id", access.userId).eq("key", "ai_notice").maybeSingle(),
  ]);
  if (company.error || !company.data || notice.error) return null;
  return {
    companyAllowed: (company.data as { ai_assistant_allowed?: unknown }).ai_assistant_allowed === true,
    noticeAccepted: noticeAccepted((notice.data as { value?: unknown } | null)?.value),
  };
}

/**
 * The gate for one capability and person. Demo companies are Blocked unless AI_IN_DEMOS=on (DEMO_TENANTS §2); real
 * companies unless listed in AI_COMPANY_ALLOWLIST (customer activation stays off until the owner lists a company).
 * Ask Taviron also needs the company's own choice and the person's first-use notice, read fresh on every call.
 */
export async function capabilityGate(id: AiCapabilityId, access: Pick<Access, "permissions" | "isDemo" | "companyId" | "userId">, ledger?: UsageLedger, config: AiConfig = aiConfig()): Promise<Gate> {
  const summary = await (ledger ?? (await sessionLedger())).summary().catch(() => null);
  const p = provider(config);
  const optIn = capability(id).needsOptIn ? await sessionOptIn(access).catch(() => null) : undefined;
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
      companyAllowed: Boolean(access.companyId && config.companyAllowlist.includes(access.companyId.toLowerCase())),
      userMonthlyTokenLimit: config.userMonthlyTokenLimit,
      monthlyCostLimitMicroUsd: config.monthlyCostLimitUsd === null ? null : Math.round(config.monthlyCostLimitUsd * 1_000_000),
      imagesAllowed: config.sendPhotos,
    },
    evidence: EVAL_EVIDENCE,
    optIn,
    usage: summary ? { tokensThisMonth: summary.tokensThisMonth, costThisMonthMicroUsd: summary.costThisMonthMicroUsd, userTokensThisMonth: summary.user.tokensThisMonth, paused: summary.paused } : null,
    isDemo: Boolean(access.isDemo),
    permissions: access.permissions,
    now: new Date(),
  });
}

export async function allCapabilityGates(access: Pick<Access, "permissions" | "isDemo" | "companyId" | "userId">) {
  const ledger = await sessionLedger();
  return Promise.all(AI_CAPABILITIES.map(async (c) => ({ capability: c, gate: await capabilityGate(c.id, access, ledger) })));
}
