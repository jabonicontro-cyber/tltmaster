import "server-only";
import { z } from "zod";
import { AI_CAPABILITIES, type AiCapabilityId } from "@/lib/ai/capabilities";

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
    models: v.AI_MODEL_PLAN_EXPLANATION ? { plan_explanation: v.AI_MODEL_PLAN_EXPLANATION } : {},
    fallbackModels: v.AI_FALLBACK_MODEL_PLAN_EXPLANATION ? { plan_explanation: v.AI_FALLBACK_MODEL_PLAN_EXPLANATION } : {},
    monthlyTokenLimit: v.AI_MONTHLY_TOKEN_LIMIT ? Number(v.AI_MONTHLY_TOKEN_LIMIT) : null,
    requestsPerMinute: v.AI_REQUESTS_PER_MINUTE ? Number(v.AI_REQUESTS_PER_MINUTE) : 6,
    timeoutMs: v.AI_TIMEOUT_MS ? Number(v.AI_TIMEOUT_MS) : 20000,
    pricing: v.AI_PRICING_JSON ? PRICE.parse(JSON.parse(v.AI_PRICING_JSON)) : {},
    inDemos: v.AI_IN_DEMOS === "on",
    invalid,
  };
}

let cached: AiConfig | null = null;

export function aiConfig(): AiConfig {
  cached ??= parseAiConfig(process.env);
  return cached;
}
