import "server-only";
import { z } from "zod";
import { AI_CAPABILITIES, type AiCapabilityId } from "@/lib/ai/capabilities";
import type { RunSettings } from "./run";

// AI configuration (docs/AI.md §3). Read on the server only; nothing here is ever sent to the browser. A key on its own
// turns nothing on: every capability also needs to be listed in AI_CAPABILITIES, have its own model, a monthly token
// cap, a working usage ledger and passing evaluation evidence for that model (src/lib/ai/capabilities.ts).
// Malformed values are ignored and named (never shown) in `invalid`, like src/server/env.ts.

const MODEL = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);

const PRICE = z.record(MODEL, z.object({
  /** US dollars per million input tokens, from the provider's price list at the time it was entered. */
  inputPerMillion: z.number().nonnegative().max(1000),
  outputPerMillion: z.number().nonnegative().max(1000),
}).strict());

const settings = {
  AI_PROVIDER: z.enum(["openai"]),
  OPENAI_API_KEY: z.string().regex(/^sk-[A-Za-z0-9_-]{20,}$/),
  AI_CAPABILITIES: z.string().regex(/^[a-z_]+(,[a-z_]+)*$/),
  AI_MODEL_PLAN_EXPLANATION: MODEL,
  AI_FALLBACK_MODEL_PLAN_EXPLANATION: MODEL,
  AI_MODEL_OPS_ASSISTANT: MODEL,
  AI_FALLBACK_MODEL_OPS_ASSISTANT: MODEL,
  AI_MODEL_TICKET_READING: MODEL,
  AI_FALLBACK_MODEL_TICKET_READING: MODEL,
  // Ticket photos go to the provider only when the owner says so: an image cannot be checked for names like text can.
  AI_SEND_PHOTOS: z.enum(["on", "off"]),
  AI_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().min(1000).max(1_000_000_000),
  AI_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(600),
  AI_TIMEOUT_MS: z.coerce.number().int().min(2000).max(60000),
  AI_PRICING_JSON: z.string().refine((v) => {
    try {
      return PRICE.safeParse(JSON.parse(v)).success;
    } catch {
      return false;
    }
  }),
  AI_IN_DEMOS: z.enum(["on", "off"]),
  // Customer activation (fail closed): real companies run AI only when listed here. Demo companies follow AI_IN_DEMOS.
  AI_COMPANY_ALLOWLIST: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$/i),
  // Per-person limits. A monthly token limit per person is required before anything runs; the others have low defaults
  // and count model calls (one question makes up to MAX_ROUNDS calls).
  AI_USER_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().min(1000).max(100_000_000),
  AI_USER_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(60),
  AI_USER_DAILY_REQUESTS: z.coerce.number().int().min(1).max(5000),
  // Optional monthly cost ceiling per company (estimated from AI_PRICING_JSON). Set it and an unpriced model is Blocked.
  AI_MONTHLY_COST_LIMIT_USD: z.coerce.number().positive().max(100_000),
  // Largest request (instructions, question, context and tool results, in characters) sent to the provider.
  AI_MAX_REQUEST_CHARS: z.coerce.number().int().min(2000).max(400_000),
} as const;

export type AiSetting = keyof typeof settings;

export interface AiConfig {
  provider: "openai" | null;
  /** Present only when set and well-formed. Never logged, returned to the client, or put in an error message. */
  apiKey: string | null;
  /** Capabilities the owner switched on explicitly. Unknown names are ignored and listed in `invalid`. */
  enabled: AiCapabilityId[];
  models: Partial<Record<AiCapabilityId, string>>;
  /** An approved fallback model per capability; used only when it also has passing evaluation evidence. */
  fallbackModels: Partial<Record<AiCapabilityId, string>>;
  monthlyTokenLimit: number | null;
  requestsPerMinute: number;
  timeoutMs: number;
  pricing: z.infer<typeof PRICE>;
  inDemos: boolean;
  /** AI_SEND_PHOTOS=on: capabilities that send ticket photos may run. Off by default. */
  sendPhotos: boolean;
  /** Real (non-demo) companies allowed to run AI. Empty: none. */
  companyAllowlist: string[];
  userMonthlyTokenLimit: number | null;
  userRequestsPerMinute: number;
  userDailyRequests: number;
  /** Estimated US dollars per company per month; null: no cost ceiling (the token limit still applies). */
  monthlyCostLimitUsd: number | null;
  maxRequestChars: number;
  /** Names (never values) of settings that were set but malformed and are being ignored. */
  invalid: string[];
}

const blank = (v: string | undefined) => (v === undefined || v.trim() === "" ? undefined : v.trim());

export function parseAiConfig(source: Record<string, string | undefined>): AiConfig {
  const invalid: string[] = [];
  const v: Partial<Record<AiSetting, string>> = {};
  for (const key of Object.keys(settings) as AiSetting[]) {
    const raw = blank(source[key]);
    if (raw === undefined) continue;
    if (settings[key].safeParse(raw).success) v[key] = raw;
    else invalid.push(key);
  }
  const known = new Set<string>(AI_CAPABILITIES.map((c) => c.id));
  const enabled: AiCapabilityId[] = [];
  for (const name of v.AI_CAPABILITIES?.split(",") ?? []) {
    if (known.has(name)) enabled.push(name as AiCapabilityId);
    else if (!invalid.includes(`AI_CAPABILITIES:${name}`)) invalid.push(`AI_CAPABILITIES:${name}`);
  }
  return {
    provider: v.AI_PROVIDER === "openai" ? "openai" : null,
    apiKey: v.OPENAI_API_KEY ?? null,
    enabled,
    models: {
      ...(v.AI_MODEL_PLAN_EXPLANATION ? { plan_explanation: v.AI_MODEL_PLAN_EXPLANATION } : {}),
      ...(v.AI_MODEL_OPS_ASSISTANT ? { ops_assistant: v.AI_MODEL_OPS_ASSISTANT } : {}),
      ...(v.AI_MODEL_TICKET_READING ? { ticket_reading: v.AI_MODEL_TICKET_READING } : {}),
    },
    fallbackModels: {
      ...(v.AI_FALLBACK_MODEL_PLAN_EXPLANATION ? { plan_explanation: v.AI_FALLBACK_MODEL_PLAN_EXPLANATION } : {}),
      ...(v.AI_FALLBACK_MODEL_OPS_ASSISTANT ? { ops_assistant: v.AI_FALLBACK_MODEL_OPS_ASSISTANT } : {}),
      ...(v.AI_FALLBACK_MODEL_TICKET_READING ? { ticket_reading: v.AI_FALLBACK_MODEL_TICKET_READING } : {}),
    },
    monthlyTokenLimit: v.AI_MONTHLY_TOKEN_LIMIT ? Number(v.AI_MONTHLY_TOKEN_LIMIT) : null,
    requestsPerMinute: v.AI_REQUESTS_PER_MINUTE ? Number(v.AI_REQUESTS_PER_MINUTE) : 6,
    timeoutMs: v.AI_TIMEOUT_MS ? Number(v.AI_TIMEOUT_MS) : 20000,
    pricing: v.AI_PRICING_JSON ? PRICE.parse(JSON.parse(v.AI_PRICING_JSON)) : {},
    inDemos: v.AI_IN_DEMOS === "on",
    sendPhotos: v.AI_SEND_PHOTOS === "on",
    companyAllowlist: v.AI_COMPANY_ALLOWLIST ? v.AI_COMPANY_ALLOWLIST.toLowerCase().split(",") : [],
    userMonthlyTokenLimit: v.AI_USER_MONTHLY_TOKEN_LIMIT ? Number(v.AI_USER_MONTHLY_TOKEN_LIMIT) : null,
    userRequestsPerMinute: v.AI_USER_REQUESTS_PER_MINUTE ? Number(v.AI_USER_REQUESTS_PER_MINUTE) : 6,
    userDailyRequests: v.AI_USER_DAILY_REQUESTS ? Number(v.AI_USER_DAILY_REQUESTS) : 150,
    monthlyCostLimitUsd: v.AI_MONTHLY_COST_LIMIT_USD ? Number(v.AI_MONTHLY_COST_LIMIT_USD) : null,
    maxRequestChars: v.AI_MAX_REQUEST_CHARS ? Number(v.AI_MAX_REQUEST_CHARS) : 40_000,
    invalid,
  };
}

/** The limits runCapability enforces, from the configuration (call only after the gate passed: limits are set). */
export function runSettings(config: AiConfig): RunSettings {
  return {
    monthlyTokenLimit: config.monthlyTokenLimit ?? 0,
    requestsPerMinute: config.requestsPerMinute,
    timeoutMs: config.timeoutMs,
    pricing: config.pricing,
    userMonthlyTokenLimit: config.userMonthlyTokenLimit ?? 0,
    userRequestsPerMinute: config.userRequestsPerMinute,
    userDailyRequests: config.userDailyRequests,
    monthlyCostLimitMicroUsd: config.monthlyCostLimitUsd === null ? null : Math.round(config.monthlyCostLimitUsd * 1_000_000),
    maxRequestChars: config.maxRequestChars,
  };
}

let cached: AiConfig | null = null;

export function aiConfig(): AiConfig {
  cached ??= parseAiConfig(process.env);
  return cached;
}
