import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { capability, evaluateGate, type GateInput } from "@/lib/ai/capabilities";
import { TICKET_EVAL_CASES, checkReading, crossCheck, gradeReading, unitCode, type RecordedTicket, type TicketReading } from "@/lib/ai/ticket-reading";
import { parseAiConfig } from "@/server/ai/config";
import { runTicketReadingEval } from "@/server/ai/evals";
import { OpenAiProvider } from "@/server/ai/openai";
import { planExplanationRequest } from "@/server/ai/plan-explanation";
import { runCapability, type RunSettings, type UsageLedger, type UsageRecord } from "@/server/ai/run";
import { ticketReadingRequest } from "@/server/ai/ticket-reading";
import type { AiProvider, CompletionRequest, CompletionResponse } from "@/server/ai/types";

// B84 "Read a ticket photo" (docs/AI.md §17). Every provider response is mocked; the core suite never calls a model.

const KEY = "sk-test_0123456789abcdefghijklmnop";
const READ: TicketReading = { readable: true, ticket_number: "SC-204518", date: "2026-09-14", material: "3/4 Clean Rock", quantity: 21.36, unit: "TN", gross_weight: 36.44, tare_weight: 15.08, net_weight: 21.36, weight_unit: "TN", truck: "T-27" };
const RECORDED: RecordedTicket = { externalReference: "sc204518", deliveredDate: "2026-09-14", loadDate: "2026-09-14", lineDescription: "3/4 Clean Rock", quantity: 21.36, unitCode: "ton", unitLabel: "Tons", truckUnit: "T27", otherTicketsWithNumber: [] };

const gate = (over: Partial<GateInput["config"]> = {}, isDemo = false) =>
  evaluateGate({
    capability: capability("ticket_reading"),
    config: { provider: "openai", hasKey: true, providerSupportsStructuredOutput: true, enabled: true, model: "vision-2030", fallbackModel: null, monthlyTokenLimit: 100_000, priced: () => true, inDemos: false, invalid: [], companyAllowed: true, userMonthlyTokenLimit: 50_000, monthlyCostLimitMicroUsd: null, imagesAllowed: true, ...over },
    evidence: [{ capability: "ticket_reading", provider: "openai", model: "vision-2030", evalVersion: capability("ticket_reading").evalVersion, ranAt: "2030-03-30T00:00:00Z", cases: 5, passed: 5, criticalFailures: 0 }],
    usage: { tokensThisMonth: 0, costThisMonthMicroUsd: 0, userTokensThisMonth: 0, paused: false },
    isDemo,
    permissions: ["tickets.review"],
    now: new Date("2030-04-01T00:00:00Z"),
  });

const SETTINGS: RunSettings = { monthlyTokenLimit: 100_000, requestsPerMinute: 6, timeoutMs: 5000, pricing: {}, userMonthlyTokenLimit: 50_000, userRequestsPerMinute: 6, userDailyRequests: 150, monthlyCostLimitMicroUsd: null, maxRequestChars: 40_000 };
function ledger(): UsageLedger & { events: UsageRecord[] } {
  const events: UsageRecord[] = [];
  return { events, summary: async () => ({ tokensThisMonth: 0, callsLastMinute: 0, costThisMonthMicroUsd: 0, paused: false, user: { tokensThisMonth: 0, callsLastMinute: 0, callsToday: 0 } }), reserve: async () => ({ ok: true }), record: async (e) => void events.push(e) };
}
function scripted(answers: unknown[]): AiProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "openai", capabilities: { structuredOutputs: true, toolCalls: true }, requests,
    async complete(req): Promise<CompletionResponse> {
      requests.push(req);
      return { id: "r", model: "vision-2030", text: JSON.stringify(answers.shift()), toolCalls: [], usage: { inputTokens: 1200, outputTokens: 90 }, refusal: null };
    },
  };
}
const IMAGE = { mediaType: "image/jpeg" as const, base64: "/9j/4AAQSkZJRgABAQ==" };

describe("gate: photos need the owner's explicit approval", () => {
  it("is Ready only with AI_SEND_PHOTOS on, and Blocked in demos unless AI is on there", () => {
    expect(gate().state).toBe("ready");
    const off = gate({ imagesAllowed: false });
    expect(off.state).toBe("blocked");
    expect(off.reasons.join(" ")).toContain("AI_SEND_PHOTOS");
    expect(gate({}, true).state).toBe("blocked");
  });

  it("a key and the switch alone enable nothing; AI_SEND_PHOTOS is off unless set to on", () => {
    const c = parseAiConfig({ AI_PROVIDER: "openai", OPENAI_API_KEY: KEY, AI_CAPABILITIES: "ticket_reading", AI_MODEL_TICKET_READING: "vision-2030" });
    expect(c.enabled).toContain("ticket_reading");
    expect(c.models.ticket_reading).toBe("vision-2030");
    expect(c.sendPhotos).toBe(false);
    expect(parseAiConfig({ AI_SEND_PHOTOS: "on" }).sendPhotos).toBe(true);
    expect(parseAiConfig({ AI_SEND_PHOTOS: "yes" }).invalid).toContain("AI_SEND_PHOTOS");
  });
});

describe("running the capability", () => {
  it("sends the photo as an image item, nothing about the ticket, and returns a checked reading", async () => {
    const p = scripted([READ]);
    const l = ledger();
    const r = await runCapability(ticketReadingRequest(IMAGE), { provider: p, ledger: l, settings: SETTINGS, gate: gate(), toolContext: { permissions: ["tickets.review"], data: null } });
    expect(r.value).toEqual(READ);
    expect(p.requests[0].input).toEqual([{ kind: "message", role: "user", text: "Read this delivery ticket photo." }, { kind: "image", ...IMAGE }]);
    expect(p.requests[0].tools).toBeUndefined();
    expect(l.events).toHaveLength(1);
  });

  it("the image data does not count toward the text size limit, but the projection reserves tokens for it", async () => {
    const big = { mediaType: "image/png" as const, base64: "A".repeat(200_000) };
    const reserved: number[] = [];
    const l = { ...ledger(), reserve: async (x: { tokens: number }) => (reserved.push(x.tokens), { ok: true as const }) };
    await runCapability(ticketReadingRequest(big), { provider: scripted([READ]), ledger: l, settings: SETTINGS, gate: gate(), toolContext: { permissions: ["tickets.review"], data: null } });
    expect(reserved[0]).toBeGreaterThan(1600);
    expect(reserved[0]).toBeLessThan(5000);
  });

  it("a capability that may not send images never sends one", async () => {
    const req = { ...planExplanationRequest({} as never, { secrets: [], labels: {}, details: {} } as never), images: [IMAGE] };
    const p = scripted([{}]);
    await expect(runCapability(req, { provider: p, ledger: ledger(), settings: SETTINGS, gate: { state: "ready", reasons: [], model: "m", fallbackModel: null, canRun: true }, toolContext: { permissions: [], data: { pseudonyms: { secrets: [], labels: {}, details: {} } } } as never })).rejects.toMatchObject({ kind: "sensitive_data" });
    expect(p.requests).toHaveLength(0);
  });

  it("answers with contact details or values for an unreadable photo are not shown", async () => {
    const leak = { ...READ, material: "call 555-201-4471" };
    await expect(runCapability(ticketReadingRequest(IMAGE), { provider: scripted([leak]), ledger: ledger(), settings: SETTINGS, gate: gate(), toolContext: { permissions: ["tickets.review"], data: null } })).rejects.toMatchObject({ kind: "invalid_output" });
    expect(checkReading({ ...READ, readable: false }).ok).toBe(false);
    expect(checkReading({ ...READ, date: "2026-13-45" }).ok).toBe(false);
  });

  it("the OpenAI adapter sends the image as input_image with high detail", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "x", model: "vision-2030", status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await new OpenAiProvider(KEY, fetchImpl as unknown as typeof fetch, 0).complete({ model: "vision-2030", instructions: "Read.", input: [{ kind: "image", ...IMAGE }], maxOutputTokens: 400 }, { timeoutMs: 1000 });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.input[0]).toEqual({ role: "user", content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${IMAGE.base64}`, detail: "high" }] });
    expect(body.store).toBe(false);
  });
});

describe("cross-checks against the ticket and the order", () => {
  const verdicts = (r: TicketReading, t: RecordedTicket = RECORDED) => Object.fromEntries(crossCheck(r, t).map((c) => [c.key, c.verdict]));

  it("matching values match, ignoring punctuation and case in numbers", () => {
    expect(verdicts(READ)).toEqual({ ticket_number: "matches", date: "matches", material: "matches", quantity: "matches", weights: "matches", truck: "matches", duplicate: "matches" });
  });

  it("differences are flagged for the reviewer, never corrected", () => {
    const v = verdicts({ ...READ, ticket_number: "SC-204519", date: "2026-09-13", quantity: 23.1, net_weight: 23.1, truck: "T-28", material: "Pea Gravel" });
    expect(v).toMatchObject({ ticket_number: "differs", date: "differs", material: "differs", quantity: "differs", weights: "differs", truck: "differs" });
  });

  it("a unit in another measure is a difference with a note; unknown units are never converted", () => {
    const yards = crossCheck({ ...READ, unit: "yd" }, RECORDED).find((c) => c.key === "quantity")!;
    expect(yards).toMatchObject({ verdict: "differs", note: "The unit differs; nothing is converted." });
    const odd = crossCheck({ ...READ, unit: "kg" }, RECORDED).find((c) => c.key === "quantity")!;
    expect(odd.verdict).toBe("differs");
    expect(odd.note).toContain("not one Taviron recognises");
    expect([unitCode("TN"), unitCode("tons"), unitCode("Loads"), unitCode("cu. yd")]).toEqual(["ton", "ton", "load", "cu_yd"]);
  });

  it("weights are checked by arithmetic only when gross, tare and net are all printed", () => {
    expect(crossCheck({ ...READ, tare_weight: null }, RECORDED).find((c) => c.key === "weights")!.verdict).toBe("nothing_to_compare");
    expect(crossCheck({ ...READ, gross_weight: null, tare_weight: null, net_weight: null }, RECORDED).some((c) => c.key === "weights")).toBe(false);
  });

  it("values not read stay 'not read'; a paper number on another ticket is a possible duplicate", () => {
    expect(verdicts({ ...READ, date: null, truck: null })).toMatchObject({ date: "not_read", truck: "not_read" });
    expect(verdicts(READ, { ...RECORDED, externalReference: null })).toMatchObject({ ticket_number: "nothing_to_compare" });
    const dup = crossCheck(READ, { ...RECORDED, otherTicketsWithNumber: ["TKT-000123"] }).find((c) => c.key === "duplicate")!;
    expect(dup).toMatchObject({ verdict: "differs", recorded: "TKT-000123" });
  });

  it("a date that matches the delivery but not the planned load says so", () => {
    expect(crossCheck(READ, { ...RECORDED, loadDate: "2026-09-12" }).find((c) => c.key === "date")!.note).toBe("The load was planned for 2026-09-12.");
  });
});

describe("evaluation", () => {
  it("invented or wrong values are critical; a value left out is not", () => {
    const smudged = TICKET_EVAL_CASES.find((k) => k.image === "smudged-date.png")!;
    const guessed = gradeReading({ ...smudged.expected, date: "2026-09-12" }, smudged.expected);
    expect(guessed).toEqual([expect.objectContaining({ rule: "invented", critical: true })]);
    const missed = gradeReading({ ...smudged.expected, truck: null }, smudged.expected);
    expect(missed).toEqual([expect.objectContaining({ rule: "missed", critical: false })]);
    expect(gradeReading({ ...smudged.expected, unit: "tons", weight_unit: "Tons", ticket_number: "sc 204777" }, smudged.expected)).toEqual([]);
  });

  it("every case has its image, and the runner grades mocked answers into evidence", async () => {
    for (const k of TICKET_EVAL_CASES) expect((await readFile(join("tests/fixtures/ai-tickets", k.image))).length).toBeGreaterThan(1000);
    const answers = TICKET_EVAL_CASES.map((k, i) => (i === 2 ? { ...k.expected, date: "2026-09-11" } : k.expected));
    const report = await runTicketReadingEval(scripted(answers), "vision-2030", new Date("2030-04-01T00:00:00Z"));
    expect(report.evidence).toMatchObject({ capability: "ticket_reading", cases: 5, passed: 4, criticalFailures: 1, evalVersion: capability("ticket_reading").evalVersion });
  });
});
