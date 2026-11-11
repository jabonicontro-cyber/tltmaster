import { beforeEach, describe, expect, it, vi } from "vitest";

// The demo's automatic refresh runs inside after() (src/app/(app)/layout.tsx), where cookies() cannot be read: the pay
// sample used to call the payroll calculation, which created its own cookie client and failed ("cookies() inside
// after()"). The calculation now takes the refresh's own client. Here the cookie client throws exactly like after()
// does, so any read that still reaches it fails the test.
const cookieClient = vi.fn(() => {
  throw new Error("Route used `cookies()` inside `after()`.");
});
vi.mock("@/server/supabase/server", () => ({ createClient: cookieClient }));

const { calculatePeriod, loadActiveRules } = await import("@/server/payroll/calculate");

/** A minimal stand-in for the session client: records which tables and functions were read. */
function fakeDb(rules: unknown[], payable: unknown[]) {
  const reads: string[] = [];
  const db = {
    from(table: string) {
      reads.push(`from:${table}`);
      const q = {
        select: () => q,
        eq: () => Promise.resolve({ data: rules, error: null }),
        in: () => Promise.resolve({ data: [], error: null }),
      };
      return q;
    },
    rpc(fn: string) {
      reads.push(`rpc:${fn}`);
      return Promise.resolve(fn === "payroll_period_work" ? { data: { payable }, error: null } : { data: { added: 0, already_recorded: 0 }, error: null });
    },
  };
  return { db: db as never, reads };
}

const rule = { id: "v1", rule_id: "r1", status: "active", effective_from: "2026-01-01", effective_to: null, formula: "loads * rate", rate: 85, unit_code: "", scope: {}, pay_rules: { name: "Sample" } };
const ticket = { ticket_id: "t1", ticket_number: "100", revision: 1, quantity: "12", order_line_id: null, driver_id: "d1", delivered_on: "2026-11-01", unit_code: "ton", customer_id: "c1", material_id: null, truck_type: null };

describe("payroll calculation with a passed-in client (no cookies)", () => {
  beforeEach(() => {
    cookieClient.mockClear();
  });

  it("reads the active pay rules through the given client", async () => {
    const { db, reads } = fakeDb([rule], []);
    const rules = await loadActiveRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: "v1", rate: "85", name: "Sample" });
    expect(reads).toEqual(["from:pay_rule_versions"]);
    expect(cookieClient).not.toHaveBeenCalled();
  });

  it("calculates and records a period through the given client only", async () => {
    const { db, reads } = fakeDb([rule], [ticket]);
    const r = await calculatePeriod("p1", true, db);
    expect(r.results).toHaveLength(1);
    expect(r.recorded).toEqual({ added: 0, already_recorded: 0 });
    expect(reads).toEqual(["rpc:payroll_period_work", "from:pay_rule_versions", "rpc:payroll_record_entries"]);
    expect(cookieClient).not.toHaveBeenCalled();
  });

  it("still uses the signed-in person's cookie session when no client is given (pages and actions)", async () => {
    await expect(loadActiveRules()).rejects.toThrow(/cookies/);
    expect(cookieClient).toHaveBeenCalledTimes(1);
  });
});
