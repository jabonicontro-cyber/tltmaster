// AI usage ledger (docs/AI.md §6): company and user come from the session, rows are append-only and visible only to
// settings managers of the same company, request keys are idempotent, and the summary counts this month and the last
// minute for the caller's own company only.
import { describe, expect, it } from "vitest";
import { withSession } from "./helpers";

const record = (key: string, inTok: number | null, outTok: number | null, outcome = "ok") =>
  ["select public.record_ai_usage($1, 'plan_explanation', 'openai', 'test-model-2030', $2, $3, $4, $5, $6, 120)",
    [key, outcome, outcome === "ok" ? null : "timeout", inTok, outTok, inTok === null ? null : 3400]] as [string, unknown[]];

describe("AI usage ledger", () => {
  it("records under the caller's company and user; summary counts only that company", () => withSession(async (s) => {
    const other = await s.createCompany("Other Haulers");
    const owner = await s.createUser("owner");
    const dispatcher = await s.createUser("dispatcher");
    const outsider = await s.createUser("owner", { companyId: other });

    await s.as(dispatcher);
    await s.query(...record("req_aaaaaaaa", 900, 120));
    await s.query(...record("req_bbbbbbbb", null, null, "error"));
    await s.query(...record("req_aaaaaaaa", 5000, 5000)); // same key: ignored
    const mine = (await s.query("select * from public.ai_usage_summary()")).rows[0];
    expect(Number(mine.tokens_this_month)).toBeGreaterThanOrEqual(1020);
    expect(mine.calls_last_minute).toBeGreaterThanOrEqual(2);

    // A dispatcher cannot read the ledger rows; an owner of the same company can.
    expect((await s.query("select * from public.ai_usage_events")).rows).toEqual([]);
    await s.as(owner);
    const rows = (await s.query("select user_id, request_key, input_tokens, output_tokens, outcome, error_kind from public.ai_usage_events where request_key in ('req_aaaaaaaa', 'req_bbbbbbbb') order by request_key")).rows;
    expect(rows).toEqual([
      { user_id: dispatcher, request_key: "req_aaaaaaaa", input_tokens: 900, output_tokens: 120, outcome: "ok", error_kind: null },
      { user_id: dispatcher, request_key: "req_bbbbbbbb", input_tokens: null, output_tokens: null, outcome: "error", error_kind: "timeout" },
    ]);

    // Another company sees none of it and its summary starts at zero.
    await s.as(outsider);
    expect((await s.query("select * from public.ai_usage_events")).rows).toEqual([]);
    const theirs = (await s.query("select * from public.ai_usage_summary()")).rows[0];
    expect(Number(theirs.tokens_this_month)).toBe(0);
  }));

  it("is append-only for app users and validates its values", () => withSession(async (s) => {
    const owner = await s.createUser("owner");
    await s.as(owner);
    await s.query(...record("req_cccccccc", 10, 10));
    await expect(s.query("insert into public.ai_usage_events (company_id, request_key, capability, provider, model, outcome, latency_ms) values ('00000000-0000-4000-8000-000000000001', 'req_dddddddd', 'x_x', 'openai', 'm', 'ok', 1)")).rejects.toThrow(/permission denied/);
    await expect(s.query("update public.ai_usage_events set input_tokens = 0")).rejects.toThrow(/permission denied/);
    await expect(s.query("delete from public.ai_usage_events")).rejects.toThrow(/permission denied/);
    await expect(s.query(...record("bad key!", 1, 1))).rejects.toThrow(/check constraint/);
    await expect(s.query(...record("req_eeeeeeee", -1, 1))).rejects.toThrow(/check constraint/);
  }));

  it("refuses callers without a company", () => withSession(async (s) => {
    const nobody = await s.createUser(null, { membership: false });
    await s.as(nobody);
    await expect(s.query(...record("req_ffffffff", 1, 1))).rejects.toThrow(/do not have access/);
    await s.as(null);
    await expect(s.query(...record("req_gggggggg", 1, 1))).rejects.toThrow(/permission denied/);
  }));
});
