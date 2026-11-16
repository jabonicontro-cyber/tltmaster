// Ask Taviron's company opt-in and first-use notice (master plan §11a, migration 20261120022000): the gate refuses to
// run until the company allowed it and the person read the current notice, in addition to every existing switch.
import { describe, expect, it } from "vitest";
import { AI_CAPABILITIES, OPT_IN_REASONS, capability, evaluateGate, type GateInput } from "@/lib/ai/capabilities";
import { AI_NOTICE, AI_NOTICE_VERSION, noticeAccepted } from "@/lib/ai/notice";

const C = capability("ops_assistant");
function gate(optIn: GateInput["optIn"], over: Partial<Omit<GateInput, "config" | "optIn">> = {}) {
  return evaluateGate({
    capability: C,
    evidence: [{ capability: "ops_assistant", provider: "openai", model: "test-model-2030", evalVersion: C.evalVersion, ranAt: "2030-03-30T00:00:00Z", cases: 6, passed: 6, criticalFailures: 0 }],
    usage: { tokensThisMonth: 0, costThisMonthMicroUsd: 0, userTokensThisMonth: 0, paused: false },
    optIn,
    isDemo: false,
    permissions: ["dispatch.view"],
    now: new Date("2030-04-01T00:00:00Z"),
    ...over,
    config: {
      provider: "openai", hasKey: true, providerSupportsStructuredOutput: true, enabled: true, model: "test-model-2030", fallbackModel: null,
      monthlyTokenLimit: 100_000, priced: () => true, inDemos: true, invalid: [], companyAllowed: true, userMonthlyTokenLimit: 50_000, monthlyCostLimitMicroUsd: null,
    },
  });
}

describe("Ask Taviron opt-in gate", () => {
  it("runs only when the company allowed it and the person read the notice", () => {
    expect(gate({ companyAllowed: true, noticeAccepted: true }).canRun).toBe(true);

    const off = gate({ companyAllowed: false, noticeAccepted: true });
    expect(off.state).toBe("blocked");
    expect(off.canRun).toBe(false);
    expect(off.reasons).toContain(OPT_IN_REASONS.company);

    const unread = gate({ companyAllowed: true, noticeAccepted: false });
    expect(unread.canRun).toBe(false);
    expect(unread.reasons).toEqual([OPT_IN_REASONS.notice]);

    const neither = gate({ companyAllowed: false, noticeAccepted: false });
    expect(neither.reasons).toEqual([OPT_IN_REASONS.company, OPT_IN_REASONS.notice]);
  });

  it("fails closed when the choice cannot be read (migration not applied) or was not passed", () => {
    expect(gate(null).reasons).toEqual([OPT_IN_REASONS.unavailable]);
    expect(gate(undefined).canRun).toBe(false);
  });

  it("applies in demo companies too (no demo exemption), and never replaces the other switches", () => {
    expect(gate({ companyAllowed: false, noticeAccepted: true }, { isDemo: true }).canRun).toBe(false);
    expect(gate({ companyAllowed: true, noticeAccepted: true }, { isDemo: true }).canRun).toBe(true);
    // Allowed and read, but the person has no permission: still blocked.
    expect(gate({ companyAllowed: true, noticeAccepted: true }, { permissions: ["fleet.view"] }).canRun).toBe(false);
    // Allowed and read, but the platform pause switch is on.
    expect(gate({ companyAllowed: true, noticeAccepted: true }, { usage: { tokensThisMonth: 0, costThisMonthMicroUsd: 0, userTokensThisMonth: 0, paused: true } }).canRun).toBe(false);
  });

  it("only Ask Taviron needs the opt-in; the other capabilities are unchanged", () => {
    expect(AI_CAPABILITIES.filter((c) => c.needsOptIn).map((c) => c.id)).toEqual(["ops_assistant"]);
    const plan = evaluateGate({ ...gateInputFor("plan_explanation"), optIn: undefined });
    expect(plan.reasons).not.toContain(OPT_IN_REASONS.unavailable);
  });
});

function gateInputFor(id: "plan_explanation"): GateInput {
  const c = capability(id);
  return {
    capability: c,
    evidence: [],
    usage: { tokensThisMonth: 0, costThisMonthMicroUsd: 0, userTokensThisMonth: 0, paused: false },
    isDemo: false,
    permissions: ["dispatch.view"],
    now: new Date("2030-04-01T00:00:00Z"),
    config: {
      provider: "openai", hasKey: true, providerSupportsStructuredOutput: true, enabled: true, model: "m", fallbackModel: null,
      monthlyTokenLimit: 1, priced: () => true, inDemos: false, invalid: [], companyAllowed: true, userMonthlyTokenLimit: 1, monthlyCostLimitMicroUsd: null,
    },
  };
}

describe("first-use notice", () => {
  it("counts only an acknowledgement of the current version or newer", () => {
    expect(noticeAccepted({ version: AI_NOTICE_VERSION, acknowledged_at: "2030-01-01T00:00:00Z" })).toBe(true);
    expect(noticeAccepted({ version: AI_NOTICE_VERSION + 1 })).toBe(true);
    expect(noticeAccepted({ version: AI_NOTICE_VERSION - 1 })).toBe(false);
    expect(noticeAccepted({ version: String(AI_NOTICE_VERSION) })).toBe(false);
    expect(noticeAccepted(null)).toBe(false);
    expect(noticeAccepted(undefined)).toBe(false);
    expect(noticeAccepted({})).toBe(false);
  });

  it("says what it does, what is sent, what is kept, that answers can be wrong, and links to privacy", () => {
    const text = AI_NOTICE.points.map((p) => `${p.heading} ${p.text}`).join(" ");
    expect(text).toMatch(/only reads/);
    expect(text).toMatch(/OpenAI/);
    expect(text).toMatch(/replaced with codes/);
    expect(text).toMatch(/counts/);
    expect(text).toMatch(/never your questions or the answers/);
    expect(text).toMatch(/AI-generated/);
    expect(text).toMatch(/can be wrong|Answers can be wrong/);
    expect(AI_NOTICE.privacyHref).toBe("/privacy#ai");
  });
});
