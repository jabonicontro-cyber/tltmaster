import { describe, expect, it } from "vitest";
import { parseAiConfig } from "@/server/ai/config";
import { runAssistantEval, runPlanExplanationEval } from "@/server/ai/evals";
import { OpenAiProvider } from "@/server/ai/openai";

// Live evaluation (docs/AI.md §5). Not part of the core suite: run with `npm run ai:eval` and a key in the environment.
// It spends real tokens (3 short requests). Copy the printed evidence into src/lib/ai/evidence.ts only if it passed.

const config = parseAiConfig(process.env);
const model = config.models.plan_explanation;

describe.skipIf(!config.apiKey || !model)("live evaluation: Explain this plan", () => {
  it("grades every case with the production checks", async () => {
    const report = await runPlanExplanationEval(new OpenAiProvider(config.apiKey!), model!);
    for (const c of report.cases) console.log(`${c.passed ? "PASS" : "FAIL"} ${c.name}${c.error ? ` — ${c.error}` : ""}${c.findings.map((f) => `\n  - ${f.rule}: ${f.detail}`).join("")}`);
    console.log(`Evidence:\n${JSON.stringify(report.evidence, null, 2)}`);
    expect(report.cases.length).toBeGreaterThan(0);
  }, 180_000);
});

const assistantModel = config.models.ops_assistant;

describe.skipIf(!config.apiKey || !assistantModel)("live evaluation: Ask Taviron", () => {
  it("grades every case with the production checks", async () => {
    const report = await runAssistantEval(new OpenAiProvider(config.apiKey!), assistantModel!);
    for (const c of report.cases) console.log(`${c.passed ? "PASS" : "FAIL"} ${c.name}${c.error ? ` — ${c.error}` : ""}${c.findings.map((f) => `\n  - ${f.rule}: ${f.detail}`).join("")}`);
    console.log(`Evidence:\n${JSON.stringify(report.evidence, null, 2)}`);
    expect(report.cases.length).toBeGreaterThan(0);
  }, 180_000);
});
