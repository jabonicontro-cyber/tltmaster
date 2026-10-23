"use server";

import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { Pseudonyms, SHOWN_FOLLOW_UPS, SHOWN_SOURCES, type AssistantKind } from "@/lib/ai/assistant";
import { capability } from "@/lib/ai/capabilities";
import { can } from "@/lib/permissions";
import { assistantRequest } from "@/server/ai/assistant";
import { aiConfig } from "@/server/ai/config";
import { capabilityGate, provider, sessionLedger } from "@/server/ai/gates";
import { runCapability } from "@/server/ai/run";
import { AiError } from "@/server/ai/types";
import { assertPermission, getAccess } from "@/server/auth";
import { sessionAssistantSource } from "@/server/data/assistant";
import { businessToday } from "@/server/data/settings";
import { guard } from "@/server/errors";

export interface AssistantView {
  kind: AssistantKind;
  /** The answer with real labels put back (server side, after every check passed). */
  answer: string;
  sources: Array<{ label: string; href: string | null }>;
  followUps: string[];
  model: string;
  tokens: { input: number | null; output: number | null };
  estimatedCostUsd: number | null;
}

const askInput = z.object({ question: z.string().trim().min(3, "Ask a question.").max(500, "Keep the question under 500 characters.") }).strict();

/**
 * Ask Taviron (docs/AI.md §12). Permission from the session; the question goes through the readiness gate, budget,
 * rate limit and leak check in runCapability; tools read the caller's own company only. Read only: nothing is changed.
 */
export async function askAssistant(input: z.input<typeof askInput>): Promise<ActionResult<AssistantView>> {
  return guard(async () => {
    const c = capability("ops_assistant");
    const first = await getAccess();
    const permission = c.anyPermission?.find((p) => can(first, p));
    if (!permission) return fail("You do not have permission to use Ask Taviron.");
    const access = await assertPermission(permission);
    const parsed = askInput.safeParse(input);
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid question.");

    const config = aiConfig();
    const ledger = await sessionLedger();
    const gate = await capabilityGate("ops_assistant", access, ledger, config);
    const ai = provider(config);
    if (!gate.canRun || !ai) return fail(`Ask Taviron is not available: ${gate.reasons[0] ?? "not configured"}`);

    const { today } = await businessToday();
    const data = { p: new Pseudonyms(), source: sessionAssistantSource(access, today), grounding: [] as string[], permissions: access.permissions };
    try {
      const run = await runCapability(await assistantRequest(parsed.data.question, data, today), {
        provider: ai,
        ledger,
        gate,
        settings: { monthlyTokenLimit: config.monthlyTokenLimit!, requestsPerMinute: config.requestsPerMinute, timeoutMs: config.timeoutMs, pricing: config.pricing },
        toolContext: { permissions: access.permissions, data },
      });
      const sources = [...new Set(run.value.sources)].map((code) => data.p.entry(code)).filter((e) => e !== null).slice(0, SHOWN_SOURCES).map((e) => ({ label: e.label, href: e.href }));
      return ok<AssistantView>({
        kind: run.value.kind,
        answer: data.p.relabel(run.value.answer),
        sources,
        followUps: run.value.followUps.slice(0, SHOWN_FOLLOW_UPS).map((f) => data.p.relabel(f)),
        model: run.model,
        tokens: { input: run.usage.inputTokens, output: run.usage.outputTokens },
        estimatedCostUsd: run.estimatedCostUsd,
      });
    } catch (e) {
      if (e instanceof AiError) return fail(`No answer: ${e.message}`);
      throw e;
    }
  });
}
