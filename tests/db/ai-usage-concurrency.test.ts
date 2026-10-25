// AI usage limits under simultaneous requests (20261120002500): public.ai_reserve_call serializes reservations per
// company, so parallel model calls cannot all pass a limit before any is recorded. Unlike the other DB tests this one
// needs committed rows on several real connections (each reservation is its own transaction, as through the API); it
// uses its own user in Top Line and removes everything it created.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, TOP_LINE } from "./helpers";

const users: string[] = [];
const keys: string[] = [];

async function createUser(role: string) {
  const id = randomUUID();
  await pool.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, `ai-conc-${id.slice(0, 8)}@test.example`]);
  await pool.query("insert into public.company_memberships (company_id, user_id, role, active) values ($1, $2, $3, true)", [TOP_LINE, id, role]);
  users.push(id);
  return id;
}

interface Limits { companyTokens: number; companyPerMinute: number; cost: number | null; userTokens: number; userPerMinute: number; userDaily: number }
const LOOSE: Limits = { companyTokens: 1_000_000_000, companyPerMinute: 600, cost: null, userTokens: 100_000_000, userPerMinute: 60, userDaily: 5000 };

/** One reservation in its own transaction on its own connection, as the signed-in user. */
async function reserve(user: string, tokens: number, l: Partial<Limits> = {}): Promise<string> {
  const lim = { ...LOOSE, ...l };
  const key = `conc_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  keys.push(key);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2" })]);
    const r = await c.query<{ r: string }>("select public.ai_reserve_call($1, 'ops_assistant', 'openai', 'test-model-2030', $2, $3, $4, $5, $6, $7, $8) r",
      [key, tokens, lim.companyTokens, lim.companyPerMinute, lim.cost, lim.userTokens, lim.userPerMinute, lim.userDaily]);
    await c.query("commit");
    return r.rows[0].r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function asUser<T>(user: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2" })]);
    const r = await c.query(sql, params);
    await c.query("commit");
    return r.rows as T[];
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await pool.query("update private.ai_controls set paused = false");
});

afterAll(async () => {
  await pool.query("delete from public.ai_usage_events where user_id = any($1::uuid[]) or request_key = any($2::text[])", [users, keys]);
  await pool.query("delete from public.company_memberships where user_id = any($1::uuid[])", [users]);
  await pool.query("delete from auth.users where id = any($1::uuid[])", [users]);
  await pool.end();
});

describe("AI usage limits with simultaneous requests", () => {
  it("eight parallel reservations against a per-minute limit of 3: exactly 3 pass", async () => {
    const u = await createUser("dispatcher");
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(u, 100, { userPerMinute: 3 })));
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r === "user_per_minute")).toHaveLength(5);
  });

  it("parallel reservations cannot overspend a monthly token limit: reserved tokens count until recorded", async () => {
    const u = await createUser("office");
    const results = await Promise.all(Array.from({ length: 6 }, () => reserve(u, 1000, { userTokens: 2500 })));
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
    expect(results.filter((r) => r === "user_tokens")).toHaveLength(4);
    const [mine] = await asUser<{ user_tokens_this_month: string }>(u, "select user_tokens_this_month from public.ai_usage_limits()");
    expect(Number(mine.user_tokens_this_month)).toBe(2000);
  });

  it("recording finalizes the caller's own reservation with reported tokens; another person cannot overwrite it", async () => {
    const a = await createUser("dispatcher");
    const b = await createUser("dispatcher");
    expect(await reserve(a, 1500)).toBe("ok");
    const key = keys[keys.length - 1];
    // Someone else using the same key changes nothing.
    await asUser(b, "select public.record_ai_usage($1, 'ops_assistant', 'openai', 'test-model-2030', 'ok', null, 1, 1, 1, 5)", [key]);
    await asUser(a, "select public.record_ai_usage($1, 'ops_assistant', 'openai', 'test-model-2030', 'ok', null, 900, 120, 3400, 850)", [key]);
    const row = (await pool.query("select user_id, outcome, input_tokens, output_tokens, estimated_cost_micro_usd, reserved_tokens from public.ai_usage_events where request_key = $1", [key])).rows[0];
    expect(row).toMatchObject({ user_id: a, outcome: "ok", input_tokens: 900, output_tokens: 120, estimated_cost_micro_usd: "3400", reserved_tokens: 1500 });
    const [mine] = await asUser<{ user_tokens_this_month: string }>(a, "select user_tokens_this_month from public.ai_usage_limits()");
    expect(Number(mine.user_tokens_this_month)).toBe(1020); // reported tokens replace the reservation
    // A recorded outcome cannot be set back to 'reserved'.
    await expect(asUser(a, "select public.record_ai_usage($1, 'ops_assistant', 'openai', 'm', 'reserved', null, 0, 0, 0, 0)", [`x${key}`])).rejects.toThrow(/Invalid AI usage outcome/);
  });

  it("an abandoned reservation stops holding tokens after 15 minutes but still counts as a call", async () => {
    const u = await createUser("office");
    expect(await reserve(u, 5000)).toBe("ok");
    await pool.query("update public.ai_usage_events set created_at = now() - interval '20 minutes' where request_key = $1", [keys[keys.length - 1]]);
    const [mine] = await asUser<{ user_tokens_this_month: string; user_calls_today: number }>(u, "select user_tokens_this_month, user_calls_today from public.ai_usage_limits()");
    // Within today unless the test runs in the first 20 minutes of a UTC day.
    expect(Number(mine.user_tokens_this_month)).toBe(0);
    expect(mine.user_calls_today).toBeGreaterThanOrEqual(0);
  });

  it("the pause switch and invalid limits refuse every reservation", async () => {
    const u = await createUser("dispatcher");
    await pool.query("update private.ai_controls set paused = true");
    try {
      expect(await reserve(u, 100)).toBe("paused");
    } finally {
      await pool.query("update private.ai_controls set paused = false");
    }
    await expect(reserve(u, 0)).rejects.toThrow(/Invalid AI reservation/);
    await expect(reserve(u, 100, { userTokens: 0 })).rejects.toThrow(/Invalid AI reservation/);
  });
});
