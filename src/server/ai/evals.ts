import "server-only";
import { ASSISTANT_EVAL_CASES, ASSISTANT_INSTRUCTIONS, ASSISTANT_JSON_SCHEMA, checkAnswer, type Finding as AssistantFinding } from "@/lib/ai/assistant";
import { capability, type EvalEvidence } from "@/lib/ai/capabilities";
import { EVAL_CASES, EXPLANATION_JSON_SCHEMA, PLAN_EXPLANATION_INSTRUCTIONS, checkExplanation, type Finding } from "@/lib/ai/plan-explanation";
import { TICKET_EVAL_CASES, READING_JSON_SCHEMA, TICKET_READING_INSTRUCTIONS, gradeReading, type ReadingFinding } from "@/lib/ai/ticket-reading";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AiError, type AiProvider } from "./types";

// Evaluation run for "Explain this plan" (docs/AI.md §5): each fictional case is sent to the model with the production
// instructions and schema, and graded by the same checks as live answers. Produces the evidence the readiness gate
// requires. Tools are not offered here: the cases already contain every fact.

export interface EvalReport {
  evidence: EvalEvidence;
  /** `answer` is the model's raw output for a failed case (fixed fictional test data only), so a failure can be read. */
  cases: Array<{ name: string; passed: boolean; findings: Array<Finding | AssistantFinding | ReadingFinding>; error: string | null; answer?: string }>;
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
      cases.push({ name: k.name, passed: findings.length === 0, findings, error: null, ...(findings.length ? { answer: res.text ?? res.refusal ?? "" } : {}) });
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
      cases.push({ name: k.name, passed: findings.length === 0, findings, error: null, ...(findings.length ? { answer: res.text ?? res.refusal ?? "" } : {}) });
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

/**
 * Evaluation run for "Read a ticket photo" (docs/AI.md §17): each fictional ticket image (tests/fixtures/ai-tickets,
 * rendered by scripts/ai/render-ticket-fixtures.mjs) is read with the production instructions and schema. Invented or
 * wrong values are critical failures; a printed value left out is not.
 */
export async function runTicketReadingEval(provider: AiProvider, model: string, now = new Date(), dir = join(process.cwd(), "tests/fixtures/ai-tickets")): Promise<EvalReport> {
  const c = capability("ticket_reading");
  const cases: EvalReport["cases"] = [];
  for (const k of TICKET_EVAL_CASES) {
    try {
      const base64 = (await readFile(join(dir, k.image))).toString("base64");
      const res = await provider.complete({
        model,
        instructions: TICKET_READING_INSTRUCTIONS,
        input: [{ kind: "message", role: "user", text: "Read this delivery ticket photo." }, { kind: "image", mediaType: "image/png", base64 }],
        output: { name: "ticket_reading", schema: READING_JSON_SCHEMA as unknown as Record<string, unknown> },
        maxOutputTokens: 400,
      }, { timeoutMs: 45000 });
      let raw: unknown = null;
      try {
        raw = JSON.parse(res.text ?? "");
      } catch {
        /* graded as a schema failure below */
      }
      const findings: ReadingFinding[] = res.refusal ? [{ rule: "schema", critical: true, detail: "The model refused." }] : gradeReading(raw, k.expected);
      const failed = findings.length > 0;
      cases.push({ name: k.name, passed: !failed, findings, error: null, ...(failed ? { answer: res.text ?? res.refusal ?? "" } : {}) });
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
