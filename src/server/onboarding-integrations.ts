import "server-only";
import { aiConfig } from "@/server/ai/config";
import { parseRoutingConfig } from "@/server/routing/service";

/**
 * What the server knows is configured, for generating a company's onboarding checklist (20261120001000). Only
 * booleans leave this function: never a key or a model name.
 */
export function onboardingIntegrations(): { routing: boolean; ai: boolean } {
  const routing = parseRoutingConfig(process.env);
  const ai = aiConfig();
  return { routing: routing.provider === "here" && Boolean(routing.key), ai: Boolean(ai.provider && ai.apiKey && ai.enabled.length) };
}
