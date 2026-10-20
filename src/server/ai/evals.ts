import "server-only";
import { ASSISTANT_EVAL_CASES, ASSISTANT_INSTRUCTIONS, ASSISTANT_JSON_SCHEMA, checkAnswer, type Finding as AssistantFinding } from "@/lib/ai/assistant";
import { capability, type EvalEvidence } from "@/lib/ai/capabilities";
import { EVAL_CASES, EXPLANATION_JSON_SCHEMA, PLAN_EXPLANATION_INSTRUCTIONS, checkExplanation, type Finding } from "@/lib/ai/plan-explanation";
import { AiError, type AiProvider } from "./types";

// Evaluation run for "Explain this plan" (docs/AI.md §5): each fictional case is sent to the model with the production
// instructions and schema, and graded by the same checks as live answers. Produces the evidence the readiness gate
// requires. Tools are not offered here: the cases already contain every fact.

export interface EvalReport {
  evidence: EvalEvidence;
  cases: Array<{ name: string; passed: boolean; findings: Array<Finding | AssistantFinding>; error: string | null }>;
}

export async function runPlanExplanationEval(provider: AiProvider, model: string, now = new Date()): Promise<EvalReport> {
  const c = capability("plan_explanation");
  const cases: EvalReport["cases"] = [];
  for (const k of EVAL_CASES) {
    try {
      const res = await provider.complete({
        model,
        instructions: PLAN_EXPLANATION_INSTRUCTIONS,
        input: [{ kind: "message", role: "user", text: JSON.stringify({ facts: k.facts }) }],
        output: { name: "plan_explanation", schema: EXPLANATION_JSON_SCHEMA },
        maxOutputTokens: 700,
      }, { timeoutMs: 30000 });
      let raw: unknown = null;
      try {
        raw = JSON.parse(res.text ?? "");
      } catch {
        /* graded as a schema failure below */
      }
      const findings = res.refusal ? [{ rule: "schema" as const, critical: true, detail: "The model refused." }] : checkExplanation(k.facts, raw, []);
      cases.push({ name: k.name, passed: findings.length === 0, findings, error: null });
    } catch (e) {
      // Provider failures are not model quality, but they still fail the case: evidence must come from real answers.
      cases.push({ name: k.name, passed: false, findings: [], error: e instanceof AiError ? `${e.kind}: ${e.message}` : "unexpected error" });
    }
  }
  return {
    evidence: {
      capability: c.id,
      provider: provider.name,
      model,
      evalVersion: c.evalVersion,
      ranAt: now.toISOString(),
      cases: cases.length,
      passed: cases.filter((x) => x.passed).length,
      criticalFailures: cases.reduce((n, x) => n + x.findings.filter((f) => f.critical).length, 0),
    },
    cases,
  };
}

/**
 * Evaluation run for Ask Taviron (docs/AI.md §12): each fictional case gives the model the question with the context
 * the server's tools would have returned, and grades the answer with the production checks plus the expected kind
 * (for example "no_data" for overdue invoices, which Taviron does not record).
 */
export async function runAssistantEval(provider: AiProvider, model: string, now = new Date()): Promise<EvalReport> {
  const c = capability("ops_assistant");
  const cases: EvalReport["cases"] = [];
  for (const k of ASSISTANT_EVAL_CASES) {
    const input = JSON.stringify({ today: k.context.today, question: k.question, ...k.context });
    try {
      const res = await provider.complete({
        model,
        instructions: ASSISTANT_INSTRUCTIONS,
        input: [{ kind: "message", role: "user", text: input }],
        output: { name: "ops_answer", schema: ASSISTANT_JSON_SCHEMA },
        maxOutputTokens: 600,
      }, { timeoutMs: 30000 });
      let raw: unknown = null;
      try {
        raw = JSON.parse(res.text ?? "");
      } catch {
        /* graded as a schema failure below */
      }
      const findings: AssistantFinding[] = res.refusal ? [{ rule: "schema", critical: true, detail: "The model refused." }] : checkAnswer(raw, input, new Set(k.codes), []);
      const kind = (raw as { kind?: unknown } | null)?.kind;
      if (!findings.length && kind !== k.expectKind) findings.push({ rule: "expected_kind", critical: false, detail: `Expected ${k.expectKind}, got ${String(kind)}.` });
      cases.push({ name: k.name, passed: findings.length === 0, findings, error: null });
    } catch (e) {
      cases.push({ name: k.name, passed: false, findings: [], error: e instanceof AiError ? `${e.kind}: ${e.message}` : "unexpected error" });
    }
  }
  return {
    evidence: {
      capability: c.id,
      provider: provider.name,
      model,
      evalVersion: c.evalVersion,
      ranAt: now.toISOString(),
      cases: cases.length,
      passed: cases.filter((x) => x.passed).length,
      criticalFailures: cases.reduce((n, x) => n + x.findings.filter((f) => f.critical).length, 0),
    },
    cases,
  };
}
