import { describe, expect, it, vi } from "vitest";
import { capability, evaluateGate, type EvalEvidence, type GateInput } from "@/lib/ai/capabilities";
import { EVAL_EVIDENCE } from "@/lib/ai/evidence";
import { EVAL_CASES, buildPlanFacts, checkExplanation, hasPhoneNumber, numbersIn, relabel } from "@/lib/ai/plan-explanation";
import type { SmartLoad } from "@/lib/dispatch/smart";
import type { Plan } from "@/lib/optimization/plan";
import { parseAiConfig } from "@/server/ai/config";
import { runPlanExplanationEval } from "@/server/ai/evals";
import { OpenAiProvider } from "@/server/ai/openai";
import { REASONING_ALLOWANCE } from "@/lib/ai/reasoning";
import { PLAN_TOOLS, planExplanationRequest, type PlanToolData } from "@/server/ai/plan-explanation";
import { estimateCostMicroUsd, findSensitive, runCapability, type RunSettings, type UsageLedger, type UsageRecord, type UsageSummary } from "@/server/ai/run";
import { executeApprovedTool, runToolCall, type Tool } from "@/server/ai/tools";
import { AiError, type AiProvider, type CompletionRequest, type CompletionResponse } from "@/server/ai/types";
import { z } from "zod";

// AI foundation (docs/AI.md). Every provider response here is mocked: the core suite never needs a key or the network.

const KEY = "sk-test_0123456789abcdefghijklmnop";

// ---- Fixtures --------------------------------------------------------------------------------------------------------

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const load = (n: number, over: Partial<SmartLoad> = {}): SmartLoad => ({
  id: ID(n), order_id: ID(100 + n), order_number: `ORD-77${n}`, customer_name: n === 3 ? "Bluestem Gravel Co" : "Ridgeway Paving LLC",
  site: n === 3 ? "1 Quarry Rd, Elm Falls" : "44 Mill St, Elm Falls", load_number: 1, load_date: "2030-04-02",
  starts_at: "2030-04-02T13:00:00Z", ends_at: "2030-04-02T15:00:00Z", planned_quantity: 22, unit_code: "ton",
  requested_date: "2030-04-02", urgent: n === 1, needed_by: null, ...over,
});
const LOADS = [load(1), load(2), load(3)];
const PLAN: Plan = {
  key: "main", label: "Balanced", priorities: { service: 3, revenue: 3, utilization: 3, efficiency: 3, balance: 3, crews: 0 }, score: 1,
  assignments: [
    { loadId: ID(1), truckId: ID(201), truckLabel: "Unit 12", trailerId: null, trailerLabel: null, driverId: ID(301), driverLabel: "Maria Okafor", status: "needs_review", reasons: ["urgent order", "Maria Okafor has no other load that day"], review: ["Hours of service not verified"] },
    { loadId: ID(2), truckId: ID(202), truckLabel: "Unit 12A", trailerId: ID(401), trailerLabel: "Trailer 7", driverId: ID(302), driverLabel: "Sam Lee", status: "needs_review", reasons: ["truck Unit 12A is already at this site that day"], review: ["Hours of service not verified"] },
  ],
  uncovered: [{ loadId: ID(3), why: "No truck-and-driver pair passes the hard constraints." }],
  metrics: { loads: 3, covered: 2, urgentTotal: 1, urgentCovered: 1, overdueTotal: 0, overdueCovered: 0, revenueCoveredCents: 184_000, revenueUnknownLoads: 1, trucksUsed: 2, driversUsed: 2, averageFill: 0.875, siteChanges: 0, workloadSpread: 0, needsReview: 2 },
};
const built = () => buildPlanFacts(PLAN, LOADS, ["Hours of service are not checked."], "2030-04-02", false);

const GOOD = {
  summary: "The Balanced plan covers 2 of 3 loads, including the urgent load L1, for an estimated $1,840 in revenue.",
  highlights: ["D1 takes urgent load L1 on T1.", "T2 with R1 stays at S1 for L2."],
  checks: ["Confirm each driver's hours of service before approving.", "L3 has no truck-and-driver pair that passes the hard constraints."],
  loadsToReview: ["L3"],
};

const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const answer = (json: unknown, usage = { input_tokens: 900, output_tokens: 120 }) => ({
  id: "resp_1", model: "test-model-2030", status: "completed", usage,
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(json) }] }],
});
const toolCallResponse = (name: string, args: string) => ({
  id: "resp_t", model: "test-model-2030", status: "completed", usage: { input_tokens: 800, output_tokens: 30 },
  output: [{ type: "function_call", call_id: "call_1", name, arguments: args }],
});

/** A provider whose answers are scripted; records each request. */
function scripted(steps: Array<CompletionResponse | AiError>): AiProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "openai",
    capabilities: { structuredOutputs: true, toolCalls: true },
    requests,
    async complete(req) {
      requests.push(structuredClone(req));
      const step = steps.shift();
      if (!step) throw new Error("no scripted response left");
      if (step instanceof AiError) throw step;
      return step;
    },
  };
}
const text = (json: unknown, model = "test-model-2030"): CompletionResponse => ({ id: "r", model, text: JSON.stringify(json), toolCalls: [], usage: { inputTokens: 900, outputTokens: 120 }, refusal: null });

type SummaryOver = Partial<Omit<UsageSummary, "user">> & { user?: Partial<UsageSummary["user"]> };
const fullSummary = (o: SummaryOver = {}): UsageSummary => ({
  tokensThisMonth: 0, callsLastMinute: 0, costThisMonthMicroUsd: 0, paused: false, ...o,
  user: { tokensThisMonth: 0, callsLastMinute: 0, callsToday: 0, ...o.user },
});

function memoryLedger(summary: SummaryOver | null = {}): UsageLedger & { events: UsageRecord[] } {
  const events: UsageRecord[] = [];
  return { events, summary: async () => (summary === null ? null : fullSummary(summary)), reserve: async () => ({ ok: true }), record: async (e) => void events.push(e) };
}

const EVIDENCE: EvalEvidence = { capability: "plan_explanation", provider: "openai", model: "test-model-2030", evalVersion: capability("plan_explanation").evalVersion, ranAt: "2030-03-30T00:00:00Z", cases: 3, passed: 3, criticalFailures: 0 };

function gateInput(over: Omit<Partial<GateInput>, "config"> & { config?: Partial<GateInput["config"]> } = {}): GateInput {
  return {
    capability: capability("plan_explanation"),
    evidence: [EVIDENCE],
    usage: { tokensThisMonth: 0, costThisMonthMicroUsd: 0, userTokensThisMonth: 0, paused: false },
    isDemo: false,
    permissions: ["dispatch.view"],
    now: new Date("2030-04-01T00:00:00Z"),
    ...over,
    config: {
      provider: "openai", hasKey: true, providerSupportsStructuredOutput: true, enabled: true, model: "test-model-2030", fallbackModel: null,
      monthlyTokenLimit: 100_000, priced: () => true, inDemos: false, invalid: [], companyAllowed: true, userMonthlyTokenLimit: 50_000, monthlyCostLimitMicroUsd: null, ...over.config,
    },
  };
}
const SETTINGS: RunSettings = {
  monthlyTokenLimit: 100_000, requestsPerMinute: 6, timeoutMs: 5000, pricing: { "test-model-2030": { inputPerMillion: 2, outputPerMillion: 8 } },
  userMonthlyTokenLimit: 50_000, userRequestsPerMinute: 6, userDailyRequests: 150, monthlyCostLimitMicroUsd: null, maxRequestChars: 40_000,
};

function deps(provider: AiProvider, ledger = memoryLedger(), gateOver: Omit<Partial<GateInput>, "config"> & { config?: Partial<GateInput["config"]> } = {}) {
  const { pseudonyms } = built();
  return { provider, ledger, settings: SETTINGS, gate: evaluateGate(gateInput(gateOver)), toolContext: { permissions: ["dispatch.view" as const], data: { pseudonyms } } };
}

// ---- Configuration ---------------------------------------------------------------------------------------------------

describe("AI configuration", () => {
  it("a key alone enables nothing", () => {
    const c = parseAiConfig({ AI_PROVIDER: "openai", OPENAI_API_KEY: KEY });
    expect(c.apiKey).toBe(KEY);
    expect(c.enabled).toEqual([]);
    expect(c.models).toEqual({});
    expect(c.monthlyTokenLimit).toBeNull();
    expect(c.inDemos).toBe(false);
  });

  it("reads explicit capability, model, limits and prices", () => {
    const c = parseAiConfig({
      AI_PROVIDER: "openai", OPENAI_API_KEY: KEY, AI_CAPABILITIES: "plan_explanation", AI_MODEL_PLAN_EXPLANATION: "test-model-2030",
      AI_MONTHLY_TOKEN_LIMIT: "200000", AI_REQUESTS_PER_MINUTE: "3", AI_TIMEOUT_MS: "15000",
      AI_PRICING_JSON: JSON.stringify({ "test-model-2030": { inputPerMillion: 2, outputPerMillion: 8 } }),
    });
    expect(c).toMatchObject({ enabled: ["plan_explanation"], models: { plan_explanation: "test-model-2030" }, monthlyTokenLimit: 200000, requestsPerMinute: 3, timeoutMs: 15000, invalid: [] });
    expect(c.pricing["test-model-2030"].outputPerMillion).toBe(8);
  });

  it("drops malformed values and names them without their values", () => {
    const c = parseAiConfig({ AI_PROVIDER: "other", OPENAI_API_KEY: "not-a-key-value", AI_CAPABILITIES: "plan_explanation,send_invoices", AI_MONTHLY_TOKEN_LIMIT: "-5", AI_PRICING_JSON: "{bad", AI_TIMEOUT_MS: "999999" });
    expect(c.provider).toBeNull();
    expect(c.apiKey).toBeNull();
    expect(c.enabled).toEqual(["plan_explanation"]);
    expect(c.invalid).toEqual(expect.arrayContaining(["AI_PROVIDER", "OPENAI_API_KEY", "AI_MONTHLY_TOKEN_LIMIT", "AI_PRICING_JSON", "AI_TIMEOUT_MS", "AI_CAPABILITIES:send_invoices"]));
    expect(JSON.stringify(c.invalid)).not.toContain("not-a-key-value");
    expect(c.timeoutMs).toBe(20000);
  });

  it("missing credentials keep the capability blocked", () => {
    const g = evaluateGate(gateInput({ config: { hasKey: false } }));
    expect(g.state).toBe("blocked");
    expect(g.canRun).toBe(false);
    expect(g.reasons.join(" ")).toContain("API key is not set");
  });

  it("committed evidence is only passing runs; an older test set does not count; a model without evidence is not Ready", () => {
    for (const e of EVAL_EVIDENCE) {
      expect(e.provider, e.capability).toBe("openai");
      expect(e.criticalFailures, e.capability).toBe(0);
      expect(e.passed / e.cases, e.capability).toBeGreaterThanOrEqual(0.9);
      expect(e.evalVersion, e.capability).toBeLessThanOrEqual(capability(e.capability).evalVersion);
      // Evidence for an older version of the test set (the capability changed since) leaves it in Needs review.
      if (e.evalVersion < capability(e.capability).evalVersion) {
        expect(evaluateGate(gateInput({ capability: capability(e.capability), permissions: ["orders.view", "dispatch.view"], evidence: [e], config: { model: e.model } })).state).toBe("needs_review");
      }
    }
    expect(evaluateGate(gateInput({ evidence: EVAL_EVIDENCE })).state).toBe("needs_review");
  });
});

// ---- Readiness gates -------------------------------------------------------------------------------------------------

describe("readiness gates", () => {
  it("Ready only with every prerequisite", () => {
    expect(evaluateGate(gateInput())).toMatchObject({ state: "ready", canRun: true, reasons: [] });
  });

  it.each([
    ["no provider", { config: { provider: null } }, "No AI provider"],
    ["not switched on", { config: { enabled: false } }, "not switched on"],
    ["no model", { config: { model: null } }, "No model"],
    ["no token limit", { config: { monthlyTokenLimit: null } }, "monthly token limit"],
    ["ledger unavailable", { usage: null }, "usage ledger"],
    ["no permission", { permissions: ["orders.view"] }, "permission"],
    ["budget used up", { usage: { tokensThisMonth: 100_000 } }, "used up"],
    ["demo company", { isDemo: true }, "demo companies"],
    ["malformed settings", { config: { invalid: ["AI_TIMEOUT_MS"] } }, "malformed"],
    ["no structured output", { config: { providerSupportsStructuredOutput: false } }, "structured output"],
  ] as const)("Blocked: %s", (_n, over, reason) => {
    const g = evaluateGate(gateInput(over as Parameters<typeof gateInput>[0]));
    expect(g.state).toBe("blocked");
    expect(g.canRun).toBe(false);
    expect(g.reasons.join(" ")).toContain(reason);
  });

  it("demo companies run only when AI_IN_DEMOS is on", () => {
    expect(evaluateGate(gateInput({ isDemo: true, config: { inDemos: true } })).state).toBe("ready");
  });

  it.each([
    ["no evidence", [], "No evaluation"],
    ["failing evidence", [{ ...EVIDENCE, passed: 2 }], "passed 2 of 3"],
    ["critical failure", [{ ...EVIDENCE, criticalFailures: 1 }], "critical"],
    ["stale evidence", [{ ...EVIDENCE, ranAt: "2029-10-01T00:00:00Z" }], "older than 90 days"],
    ["older test set", [{ ...EVIDENCE, evalVersion: 0 }], "older test set"],
    ["another model's evidence", [{ ...EVIDENCE, model: "other-model" }], "No evaluation"],
  ] as const)("Needs review: %s", (_n, evidence, reason) => {
    const g = evaluateGate(gateInput({ evidence: [...evidence] }));
    expect(g.state).toBe("needs_review");
    expect(g.canRun).toBe(false);
    expect(g.reasons.join(" ")).toContain(reason);
  });

  it("the latest evaluation decides (a newer failing run overrides an older pass)", () => {
    expect(evaluateGate(gateInput({ evidence: [EVIDENCE, { ...EVIDENCE, ranAt: "2030-03-31T00:00:00Z", passed: 1 }] })).state).toBe("needs_review");
  });

  it("Limited: no price (cost not estimated) or 80% of the budget used", () => {
    expect(evaluateGate(gateInput({ config: { priced: () => false } }))).toMatchObject({ state: "limited", canRun: true });
    expect(evaluateGate(gateInput({ usage: { tokensThisMonth: 85_000, costThisMonthMicroUsd: 0, userTokensThisMonth: 0, paused: false } })).reasons[0]).toContain("85%");
  });

  it("a fallback model is approved only with its own passing evidence", () => {
    expect(evaluateGate(gateInput({ config: { fallbackModel: "fallback-2030" } }))).toMatchObject({ state: "limited", fallbackModel: null });
    expect(evaluateGate(gateInput({ config: { fallbackModel: "fallback-2030" }, evidence: [EVIDENCE, { ...EVIDENCE, model: "fallback-2030" }] }))).toMatchObject({ state: "ready", fallbackModel: "fallback-2030" });
  });
});

// ---- OpenAI adapter --------------------------------------------------------------------------------------------------

describe("OpenAI adapter", () => {
  const request: CompletionRequest = {
    model: "test-model-2030", instructions: "Explain.", input: [{ kind: "message", role: "user", text: "{}" }],
    tools: [{ name: "get_load_details", description: "d", parameters: { type: "object" } }],
    output: { name: "plan_explanation", schema: { type: "object" } }, maxOutputTokens: 700,
  };

  it("sends a strict structured request with store: false and parses the answer and usage", async () => {
    const fetchImpl = vi.fn(async () => resp(answer(GOOD)));
    const r = await new OpenAiProvider(KEY, fetchImpl as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "test-model-2030", store: false, max_output_tokens: 700, text: { format: { type: "json_schema", name: "plan_explanation", strict: true } } });
    expect(body.tools[0]).toMatchObject({ type: "function", name: "get_load_details", strict: true });
    expect(JSON.parse(r.text!)).toEqual(GOOD);
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
  });

  it("gives reasoning models (gpt-5, o-series) low effort and room to reason; other models keep their cap", async () => {
    const send = async (model: string) => {
      const fetchImpl = vi.fn(async () => resp(answer(GOOD)));
      await new OpenAiProvider(KEY, fetchImpl as unknown as typeof fetch, 0).complete({ ...request, model }, { timeoutMs: 1000 });
      return JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    };
    const reasoning = await send("gpt-5-mini");
    expect(reasoning).toMatchObject({ max_output_tokens: 700 + REASONING_ALLOWANCE, reasoning: { effort: "low" } });
    expect(await send("o4-mini")).toMatchObject({ max_output_tokens: 700 + REASONING_ALLOWANCE });
    const plain = await send("test-model-2030");
    expect(plain.max_output_tokens).toBe(700);
    expect(plain.reasoning).toBeUndefined();
  });

  it("encodes tool calls and results and parses function calls", async () => {
    const fetchImpl = vi.fn(async () => resp(toolCallResponse("get_load_details", '{"load":"L1"}')));
    const r = await new OpenAiProvider(KEY, fetchImpl as unknown as typeof fetch, 0).complete({ ...request, input: [
      { kind: "message", role: "user", text: "{}" },
      { kind: "tool_call", callId: "c0", name: "get_load_details", arguments: '{"load":"L2"}' },
      { kind: "tool_result", callId: "c0", output: "{}" },
    ] }, { timeoutMs: 1000 });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.input[1]).toEqual({ type: "function_call", call_id: "c0", name: "get_load_details", arguments: '{"load":"L2"}' });
    expect(body.input[2]).toEqual({ type: "function_call_output", call_id: "c0", output: "{}" });
    expect(r.text).toBeNull();
    expect(r.toolCalls).toEqual([{ callId: "call_1", name: "get_load_details", arguments: '{"load":"L1"}' }]);
  });

  it("auth failures are not retried and never include the key", async () => {
    const fetchImpl = vi.fn(async () => resp({ error: { message: "Incorrect API key provided" } }, 401));
    const e = await new OpenAiProvider(KEY, fetchImpl as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 }).catch((x) => x);
    expect(e).toBeInstanceOf(AiError);
    expect(e.kind).toBe("auth");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(e.message).not.toContain(KEY);
  });

  it("rate limits and 5xx are retried exactly once", async () => {
    const twice = vi.fn().mockResolvedValueOnce(resp({ error: { message: "slow down" } }, 429)).mockResolvedValueOnce(resp(answer(GOOD)));
    expect((await new OpenAiProvider(KEY, twice as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 })).text).toBeTruthy();
    expect(twice).toHaveBeenCalledTimes(2);

    const always = vi.fn(async () => resp({}, 503));
    const e = await new OpenAiProvider(KEY, always as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 }).catch((x) => x);
    expect(e.kind).toBe("provider");
    expect(always).toHaveBeenCalledTimes(2);

    const limited = vi.fn(async () => resp({}, 429));
    expect((await new OpenAiProvider(KEY, limited as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 }).catch((x) => x)).kind).toBe("rate_limit");
  });

  it("bad requests are not retried", async () => {
    const f = vi.fn(async () => resp({ error: { message: "Invalid schema" } }, 400));
    const e = await new OpenAiProvider(KEY, f as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 }).catch((x) => x);
    expect(e.kind).toBe("bad_request");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("times out with the abort signal, once retried", async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => {
      init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const e = await new OpenAiProvider(KEY, hang as unknown as typeof fetch, 0).complete(request, { timeoutMs: 20 }).catch((x) => x);
    expect(e.kind).toBe("timeout");
    expect(hang).toHaveBeenCalledTimes(2);
  });

  it("malformed, cut-off and refused answers are classified", async () => {
    const notJson = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect((await new OpenAiProvider(KEY, notJson as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 }).catch((x) => x)).kind).toBe("provider");
    const cut = vi.fn(async () => resp({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }));
    expect((await new OpenAiProvider(KEY, cut as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 }).catch((x) => x)).kind).toBe("invalid_output");
    const refused = vi.fn(async () => resp({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }));
    expect((await new OpenAiProvider(KEY, refused as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 })).refusal).toBe("No.");
    const noUsage = vi.fn(async () => resp({ ...answer(GOOD), usage: null }));
    expect((await new OpenAiProvider(KEY, noUsage as unknown as typeof fetch, 0).complete(request, { timeoutMs: 1000 })).usage).toEqual({ inputTokens: null, outputTokens: null });
  });
});

// ---- Pseudonymization and answer checks ------------------------------------------------------------------------------

describe("Explain this plan: facts and checks", () => {
  it("sends codes, never names, order or unit numbers, addresses or ids", () => {
    const { facts, pseudonyms } = built();
    const sent = JSON.stringify(facts);
    for (const real of ["Maria Okafor", "Sam Lee", "Unit 12", "Trailer 7", "ORD-771", "Ridgeway", "Bluestem", "Quarry Rd", ID(1)]) expect(sent).not.toContain(real);
    expect(facts.assignments[0]).toMatchObject({ load: "L1", truck: "T1", driver: "D1", reasons: ["urgent order", "D1 has no other load that day"] });
    expect(facts.assignments[1].reasons).toEqual(["truck T2 is already at this site that day"]); // "Unit 12A" before "Unit 12"
    expect(facts.metrics.revenueCoveredDollars).toBe(1840);
    const req = planExplanationRequest(facts, pseudonyms);
    expect(findSensitive(JSON.stringify({ instructions: req.instructions, input: req.input, output: req.output }), pseudonyms.secrets)).toBeNull();
    expect(relabel("D1 drives L1 on T2", pseudonyms.labels)).toBe("Maria Okafor drives ORD-771 load 1 on Unit 12A");
  });

  it("a grounded answer passes", () => {
    const { facts, pseudonyms } = built();
    expect(checkExplanation(facts, GOOD, pseudonyms.secrets)).toEqual([]);
  });

  it.each([
    ["invented figure", { ...GOOD, summary: "Covers 2 of 3 loads for $2,500." }, "invented_number"],
    ["unknown load", { ...GOOD, loadsToReview: ["L9"] }, "unknown_reference"],
    ["optimal claim", { ...GOOD, summary: "This is the optimal plan for 2 of 3 loads." }, "forbidden_claim"],
    ["verified claim", { ...GOOD, highlights: ["Every assignment is verified."] }, "forbidden_claim"],
    ["margin estimate", { ...GOOD, highlights: ["Margin looks healthy."] }, "forbidden_claim"],
    ["profit", { ...GOOD, highlights: ["Good profit today."] }, "forbidden_claim"],
    ["leaked name", { ...GOOD, highlights: ["Maria Okafor takes L1."] }, "sensitive_data"],
    ["email", { ...GOOD, highlights: ["Email dispatch@example.com about L3."] }, "sensitive_data"],
    ["phone", { ...GOOD, highlights: ["Call (555) 010-0140 about L3."] }, "sensitive_data"],
    ["extra field", { ...GOOD, assign: true }, "schema"],
    ["too many highlights", { ...GOOD, highlights: ["a", "b", "c", "d", "e"] }, "schema"],
  ])("rejects: %s", (_n, raw, rule) => {
    const { facts, pseudonyms } = built();
    const findings = checkExplanation(facts, raw, pseudonyms.secrets);
    expect(findings.map((f) => f.rule)).toContain(rule);
    expect(findings.find((f) => f.rule === rule)!.critical).toBe(true);
  });

  it("phone numbers need at least 10 digits: dates, times and short figures are not phone numbers", () => {
    for (const p of ["(555) 010-0140", "555-010-0140", "+1 555 010 0140"]) expect(hasPhoneNumber(`Call ${p} today`), p).toBe(true);
    for (const t of ["Loads on 2026-10-14 and 2026-10-15", "06:30-09:30", "3 of 4 (75%)", "555-0101", "1 2 3 4 5"]) expect(hasPhoneNumber(t), t).toBe(false);
  });

  it("requires the hours-of-service caution (non-critical) while HOS is unverified; negated 'verified' is allowed", () => {
    const { facts } = built();
    const f = checkExplanation(facts, { ...GOOD, checks: ["Hours of service are not verified."] }, []);
    expect(f).toEqual([]);
    expect(checkExplanation(facts, { ...GOOD, checks: [] }, [])).toEqual([expect.objectContaining({ rule: "hos_caution", critical: false })]);
  });

  it("numbers are read as written; codes are not numbers", () => {
    expect(numbersIn("L12 covers $1,840 and 88% on 2030-04-02")).toEqual([1840, 88, 2030, 4, 2]);
  });

  it("every evaluation case is internally consistent (its facts contain the codes it uses)", () => {
    for (const c of EVAL_CASES) {
      const codes = new Set(JSON.stringify(c.facts).match(/\b[LCSTRD]\d+\b/g));
      expect(codes.has("L1"), c.name).toBe(true);
      expect(c.facts.hoursOfServiceVerified).toBe(false);
    }
  });
});

// ---- Tools ------------------------------------------------------------------------------------------------------------

describe("approved tools", () => {
  const ctx = () => ({ permissions: ["dispatch.view" as const], data: { pseudonyms: built().pseudonyms } });

  it("read tool returns pseudonymous details for this plan's loads only", async () => {
    const r = await runToolCall(PLAN_TOOLS, { name: "get_load_details", arguments: '{"load":"L1"}' }, ctx(), "propose");
    expect(r.status).toBe("ok");
    expect(JSON.parse(r.output)).toMatchObject({ load: "L1", customer: "C1", urgent: true, quantity: 22 });
    expect(r.output).not.toContain("Ridgeway");
    const other = await runToolCall(PLAN_TOOLS, { name: "get_load_details", arguments: '{"load":"L42"}' }, ctx(), "propose");
    expect(JSON.parse(other.output)).toEqual({ error: "No such load in this plan." });
  });

  it("cross-tenant or raw ids are refused: tools take plan codes, never ids or company ids", async () => {
    const id = await runToolCall(PLAN_TOOLS, { name: "get_load_details", arguments: JSON.stringify({ load: ID(999) }) }, ctx(), "propose");
    expect(id).toMatchObject({ status: "refused", reason: "invalid" });
    const company = await runToolCall(PLAN_TOOLS, { name: "get_load_details", arguments: JSON.stringify({ load: "L1", company_id: ID(5) }) }, ctx(), "propose");
    expect(company).toMatchObject({ status: "refused", reason: "invalid" });
  });

  it("malformed arguments, unknown tools and missing permissions are refused without running", async () => {
    expect(await runToolCall(PLAN_TOOLS, { name: "get_load_details", arguments: "{load:" }, ctx(), "propose")).toMatchObject({ status: "refused", reason: "malformed" });
    expect(await runToolCall(PLAN_TOOLS, { name: "assign_load", arguments: "{}" }, ctx(), "propose")).toMatchObject({ status: "refused", reason: "unknown_tool" });
    expect(await runToolCall(PLAN_TOOLS, { name: "get_load_details", arguments: '{"load":"L1"}' }, { ...ctx(), permissions: ["orders.view"] }, "propose")).toMatchObject({ status: "refused", reason: "permission" });
  });

  it("propose tools record a suggestion only, and are refused under a read-only ceiling", async () => {
    const args = JSON.stringify({ service: 5, revenue: 1, utilization: 2, efficiency: 2, balance: 2, crews: 0, reason: "L3 is open." });
    const r = await runToolCall(PLAN_TOOLS, { name: "propose_priorities", arguments: args }, ctx(), "propose");
    expect(r).toMatchObject({ status: "ok", proposal: { tool: "propose_priorities" } });
    expect(await runToolCall(PLAN_TOOLS, { name: "propose_priorities", arguments: args }, ctx(), "read")).toMatchObject({ status: "refused", reason: "kind" });
    expect(await runToolCall(PLAN_TOOLS, { name: "propose_priorities", arguments: JSON.stringify({ service: 9, revenue: 1, utilization: 2, efficiency: 2, balance: 2, crews: 0, reason: "x" }) }, ctx(), "propose")).toMatchObject({ status: "refused", reason: "invalid" });
  });

  it("execute tools never run from the model loop; they need a person's approval with permission and fresh validation", async () => {
    const run = vi.fn(() => "done");
    const exec: Tool<PlanToolData> = { name: "assign", description: "", kind: "execute", permission: "dispatch.edit", parameters: {}, args: z.object({ load: z.string() }).strict() as z.ZodType<unknown>, run };
    const r = await runToolCall([exec], { name: "assign", arguments: '{"load":"L1"}' }, { ...ctx(), permissions: ["dispatch.edit"] }, "propose");
    expect(r).toMatchObject({ status: "needs_approval", pending: { tool: "assign", args: { load: "L1" } } });
    expect(run).not.toHaveBeenCalled();
    expect(await executeApprovedTool([exec], { tool: "assign", args: { load: "L1" } }, ctx())).toEqual({ ok: false, error: "You are not allowed to approve this action." });
    expect(await executeApprovedTool([exec], { tool: "assign", args: { load: 7 } }, { ...ctx(), permissions: ["dispatch.edit"] })).toMatchObject({ ok: false });
    expect(await executeApprovedTool(PLAN_TOOLS, { tool: "get_load_details", args: { load: "L1" } }, ctx())).toMatchObject({ ok: false });
    expect(await executeApprovedTool([exec], { tool: "assign", args: { load: "L1" } }, { ...ctx(), permissions: ["dispatch.edit"] })).toEqual({ ok: true, result: "done" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

// ---- Orchestrator -----------------------------------------------------------------------------------------------------

describe("running a capability", () => {
  const request = () => { const { facts, pseudonyms } = built(); return planExplanationRequest(facts, pseudonyms); };

  it("tool round then a validated answer; every call recorded with reported tokens and an estimated cost", async () => {
    const p = scripted([
      { id: "a", model: "test-model-2030", text: null, toolCalls: [{ callId: "c1", name: "get_load_details", arguments: '{"load":"L3"}' }], usage: { inputTokens: 800, outputTokens: 30 }, refusal: null },
      text(GOOD),
    ]);
    const ledger = memoryLedger();
    const r = await runCapability(request(), deps(p, ledger));
    expect(r.value).toEqual(GOOD);
    expect(r.calls).toBe(2);
    expect(r.usage).toEqual({ inputTokens: 1700, outputTokens: 150 });
    expect(r.estimatedCostUsd).toBeCloseTo((1700 * 2 + 150 * 8) / 1e6);
    expect(ledger.events.map((e) => [e.outcome, e.inputTokens, e.outputTokens])).toEqual([["ok", 800, 30], ["ok", 900, 120]]);
    expect(new Set(ledger.events.map((e) => e.requestKey)).size).toBe(2);
    expect(p.requests[1].input.at(-1)).toMatchObject({ kind: "tool_result", callId: "c1" });
    expect(JSON.stringify(p.requests)).not.toContain("Bluestem");
  });

  it("reported usage stays separate from estimates: no price means no cost estimate", () => {
    expect(estimateCostMicroUsd("unpriced", { inputTokens: 10, outputTokens: 10 }, {})).toBeNull();
    expect(estimateCostMicroUsd("test-model-2030", { inputTokens: null, outputTokens: 10 }, SETTINGS.pricing)).toBeNull();
    expect(estimateCostMicroUsd("test-model-2030", { inputTokens: 1_000_000, outputTokens: 0 }, SETTINGS.pricing)).toBe(2_000_000);
  });

  it("a closed gate never calls the provider", async () => {
    const p = scripted([text(GOOD)]);
    await expect(runCapability(request(), deps(p, memoryLedger(), { evidence: [] }))).rejects.toMatchObject({ kind: "disabled" });
    await expect(runCapability(request(), deps(p, memoryLedger(), { permissions: [] }))).rejects.toMatchObject({ kind: "disabled" });
    expect(p.requests).toHaveLength(0);
  });

  it("no ledger, rate limit or budget: nothing is sent", async () => {
    const p = scripted([text(GOOD)]);
    await expect(runCapability(request(), deps(p, memoryLedger(null)))).rejects.toMatchObject({ kind: "not_configured" });
    await expect(runCapability(request(), deps(p, memoryLedger({ tokensThisMonth: 0, callsLastMinute: 6 })))).rejects.toMatchObject({ kind: "rate_limit" });
    await expect(runCapability(request(), deps(p, memoryLedger({ tokensThisMonth: 99_900, callsLastMinute: 0 })))).rejects.toMatchObject({ kind: "budget" });
    expect(p.requests).toHaveLength(0);
  });

  it("the budget check counts a reasoning model's reasoning allowance", async () => {
    const r = request();
    const answerOnly = Math.ceil((r.instructions.length + r.input.length) / 3) + r.maxOutputTokens;
    const ledger = () => memoryLedger({ tokensThisMonth: 100_000 - answerOnly - 10, callsLastMinute: 0 });
    // Room for the answer alone: a plain model runs, a reasoning model is refused before anything is sent.
    expect((await runCapability(r, deps(scripted([text(GOOD)]), ledger()))).value).toEqual(GOOD);
    const p = scripted([text(GOOD)]);
    const reasoning = deps(p, ledger(), { config: { model: "gpt-5-mini" }, evidence: [{ ...EVIDENCE, model: "gpt-5-mini" }] });
    await expect(runCapability(r, reasoning)).rejects.toMatchObject({ kind: "budget" });
    expect(p.requests).toHaveLength(0);
  });

  it("refuses to send sensitive data", async () => {
    const p = scripted([text(GOOD)]);
    const req = { ...request(), input: "Call Maria at maria@example.com" };
    await expect(runCapability(req, deps(p))).rejects.toMatchObject({ kind: "sensitive_data" });
    await expect(runCapability({ ...request(), input: `load ${ID(1)}` }, deps(p))).rejects.toMatchObject({ kind: "sensitive_data" });
    expect(p.requests).toHaveLength(0);
  });

  it("invalid answers are rejected and recorded as errors", async () => {
    for (const bad of [{ ...GOOD, summary: "Covers 7 of 3 loads." }, "not json"]) {
      const ledger = memoryLedger();
      const p = scripted([typeof bad === "string" ? { ...text(GOOD), text: bad } : text(bad)]);
      await expect(runCapability(request(), deps(p, ledger))).rejects.toMatchObject({ kind: "invalid_output" });
      expect(ledger.events).toEqual([expect.objectContaining({ outcome: "error", errorKind: "invalid_output", inputTokens: 900 })]);
    }
  });

  it("stops after the round limit and after repeated tool refusals", async () => {
    const call = (name: string): CompletionResponse => ({ id: "x", model: "m", text: null, toolCalls: [{ callId: "c", name, arguments: '{"load":"L1"}' }], usage: { inputTokens: 10, outputTokens: 5 }, refusal: null });
    await expect(runCapability(request(), deps(scripted([call("get_load_details"), call("get_load_details"), call("get_load_details")])))).rejects.toMatchObject({ kind: "invalid_output" });
    const many: CompletionResponse = { ...call("x"), toolCalls: [1, 2, 3].map((i) => ({ callId: `c${i}`, name: "delete_everything", arguments: "{}" })) };
    await expect(runCapability(request(), deps(scripted([many])))).rejects.toMatchObject({ kind: "tool" });
  });

  it("provider failures are recorded; an approved fallback is tried once for availability failures only", async () => {
    const evidence = [EVIDENCE, { ...EVIDENCE, model: "fallback-2030" }];
    const ledger = memoryLedger();
    const p = scripted([new AiError("timeout", "slow", true), text(GOOD, "fallback-2030")]);
    const r = await runCapability(request(), deps(p, ledger, { evidence, config: { fallbackModel: "fallback-2030" } }));
    expect(r).toMatchObject({ usedFallback: true, model: "fallback-2030" });
    expect(p.requests.map((x) => x.model)).toEqual(["test-model-2030", "fallback-2030"]);
    expect(ledger.events.map((e) => [e.model, e.outcome, e.errorKind])).toEqual([["test-model-2030", "error", "timeout"], ["fallback-2030", "ok", null]]);

    // No fallback for auth failures or invalid answers, and none without approved evidence.
    const auth = scripted([new AiError("auth", "no"), text(GOOD)]);
    await expect(runCapability(request(), deps(auth, memoryLedger(), { evidence, config: { fallbackModel: "fallback-2030" } }))).rejects.toMatchObject({ kind: "auth" });
    expect(auth.requests).toHaveLength(1);
    const unapproved = scripted([new AiError("rate_limit", "busy", true), text(GOOD)]);
    await expect(runCapability(request(), deps(unapproved, memoryLedger(), { config: { fallbackModel: "fallback-2030" } }))).rejects.toMatchObject({ kind: "rate_limit" });
    expect(unapproved.requests).toHaveLength(1);
  });

  it("a model's refusal is not an answer", async () => {
    await expect(runCapability(request(), deps(scripted([{ ...text(GOOD), text: null, refusal: "No." }])))).rejects.toMatchObject({ kind: "invalid_output" });
  });
});

// ---- Evaluation runner -----------------------------------------------------------------------------------------------

describe("evaluation runner", () => {
  it("produces evidence from graded answers; provider errors fail cases", async () => {
    const good = (i: number) => {
      const f = EVAL_CASES[i].facts;
      return text({ summary: `The ${f.plan} plan covers ${f.metrics.covered} of ${f.metrics.loads} loads.`, highlights: [], checks: ["Confirm each driver's hours of service."], loadsToReview: [] });
    };
    const ok = await runPlanExplanationEval(scripted(EVAL_CASES.map((_, i) => good(i))), "test-model-2030", new Date("2030-04-01T00:00:00Z"));
    expect(ok.evidence).toMatchObject({ capability: "plan_explanation", provider: "openai", model: "test-model-2030", evalVersion: capability("plan_explanation").evalVersion, cases: EVAL_CASES.length, passed: EVAL_CASES.length, criticalFailures: 0 });
    expect(evaluateGate(gateInput({ evidence: [ok.evidence] })).state).toBe("ready");

    const steps: Array<CompletionResponse | AiError> = EVAL_CASES.map((_, i) => good(i));
    steps[0] = text({ summary: "The optimal plan covers 99 loads.", highlights: [], checks: [], loadsToReview: [] });
    steps[1] = new AiError("timeout", "slow", true);
    const bad = await runPlanExplanationEval(scripted(steps), "test-model-2030", new Date("2030-04-01T00:00:00Z"));
    expect(bad.evidence.passed).toBe(EVAL_CASES.length - 2);
    expect(bad.evidence.criticalFailures).toBeGreaterThan(0);
    expect(evaluateGate(gateInput({ evidence: [bad.evidence] })).state).toBe("needs_review");
  });
});
