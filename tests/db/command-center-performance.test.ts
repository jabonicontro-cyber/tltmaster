import { afterAll, describe, expect, it } from "vitest";
import { pool, TOP_LINE, withSession } from "./helpers";

afterAll(() => pool.end());

// Command Center speed (master plan §8 P7; migrations 20261114000100 and 20261114000200). Timing tests would be flaky,
// so these check the structure that made the queue slow: per-row permission checks and repeated, unscoped billing scans.

type PlanNode = { "Relation Name"?: string; Plans?: PlanNode[] };
function scans(plan: PlanNode, out: Record<string, number> = {}) {
  if (plan["Relation Name"]) out[plan["Relation Name"]] = (out[plan["Relation Name"]] ?? 0) + 1;
  for (const p of plan.Plans ?? []) scans(p, out);
  return out;
}

const ALL_KINDS = [
  "missing_ticket", "unassigned_load", "ticket_review", "billing_blocked", "equipment_out_of_service",
  "assignment_problem", "delay_report", "equipment_report", "urgent_order", "order_unscheduled",
];

describe("Command Center queue performance structure", () => {
  it("billing exceptions read order lines once (not once per line exception kind)", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      const r = await s.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
        "explain (format json) select * from public.billing_exceptions where company_id = $1", [TOP_LINE]);
      const n = scans(r.rows[0]["QUERY PLAN"][0].Plan);
      // Before 20261114000100: order_lines 7 times, delivery_tickets 14 times.
      expect(n.order_lines ?? 0).toBeLessThanOrEqual(2);
      expect(n.delivery_tickets ?? 0).toBeLessThanOrEqual(6);
    });
  });

  it("visibility is decided once per kind and matches the per-kind rule for every role", async () => {
    await withSession(async (s) => {
      for (const role of ["owner", "office", "dispatcher", "mechanic", "driver"] as const) {
        const user = await s.createUser(role);
        await s.as(user);
        await s.query("reset role"); // internal functions are not callable by app users; keep this user's identity (JWT claims)
        const once = (await s.query<{ k: string[] }>("select private.visible_exception_kinds() as k")).rows[0].k;
        const perKind = (await s.query<{ k: string }>("select k from unnest($1::text[]) k where private.exception_visible(k)", [ALL_KINDS])).rows.map((r) => r.k);
        expect(once.sort(), role).toEqual(perKind.sort());
      }
    });
  });

  it("every kind the queue produces is in the once-per-call list (a new kind cannot be hidden by accident)", async () => {
    await withSession(async (s) => {
      await s.asAdmin();
      // Since 20261120001700 the kinds are produced by operational_exceptions_all; operational_exceptions scopes them.
      const src = (await s.query<{ src: string }>(
        "select string_agg(prosrc, E'\\n') as src from pg_proc where proname in ('operational_exceptions', 'operational_exceptions_all')")).rows[0].src;
      const produced = [...src.matchAll(/'([a-z_]+):' \|\|/g)].map((m) => m[1]);
      expect(produced.length).toBeGreaterThanOrEqual(9);
      // Field reports are keyed 'field_report:' and come in two kinds.
      for (const k of produced.flatMap((p) => (p === "field_report" ? ["delay_report", "equipment_report"] : [p]))) expect(ALL_KINDS, k).toContain(k);
      const listed = (await s.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'visible_exception_kinds'")).rows[0].src;
      for (const k of ALL_KINDS) expect(listed, k).toContain(`'${k}'`);
    });
  });
});
