import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const refreshed = vi.fn();
vi.mock("@/server/demo/northfield-refresh", () => ({ refreshNorthfield: async () => { refreshed("northfield"); return { added: [], notes: [] }; } }));
vi.mock("@/server/demo/prairie-lantern-refresh", () => ({ refreshPrairieLantern: async () => { refreshed("prairie"); return { added: [], notes: [] }; } }));
vi.mock("@/server/demo/freight-demo", () => ({ FREIGHT_DEMO: { name: "Cobalt Plains Freight" }, refreshFreightDemo: async () => { refreshed("freight"); return { added: [], notes: [] }; } }));
vi.mock("@/server/demo/prairie-lantern", () => ({ PRAIRIE_LANTERN: { name: "Prairie Lantern Freight", timeZone: "America/Chicago" } }));
vi.mock("@/server/demo/samples", () => ({ ensureFeatureSamples: async () => { refreshed("samples"); return { added: [], notes: [] }; }, refreshSummary: () => "ok" }));

import { autoRefreshDemo, withDemoRefreshLock } from "@/server/demo/auto-refresh";

/** A stand-in for the signed-in Supabase client: the reads the refresh makes, and every RPC it calls in order. */
function fakeDb(o: { customers: number; begin?: boolean[] }) {
  const calls: string[] = [];
  const begins = [...(o.begin ?? [true])];
  const table = (name: string) => {
    const rows = name === "companies" ? [{ name: "Prairie Lantern Freight", demo_kind: "prospect", is_demo: true }]
      : name === "company_settings" ? [{ timezone: "America/Chicago" }]
      : name === "customers" ? Array.from({ length: o.customers }, (_, i) => ({ id: `c${i}` })) : [];
    const q = {
      select: () => q, eq: () => q,
      limit: async (n: number) => ({ data: rows.slice(0, n), error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    };
    return q;
  };
  const db = {
    from: table,
    rpc: async (fn: string) => {
      calls.push(fn);
      if (fn === "my_access") return { data: { company_id: "demo-1" }, error: null };
      if (fn === "demo_auto_refresh_claim") return { data: true, error: null };
      if (fn === "demo_refresh_begin") return { data: begins.shift() ?? true, error: null };
      return { data: null, error: null };
    },
  };
  return { db: db as never, calls };
}

describe("demo refresh and the first fill (X1)", () => {
  it("an automatic refresh leaves a demo that is still being created (no customers yet) alone", async () => {
    refreshed.mockClear();
    const { db, calls } = fakeDb({ customers: 0 });
    await autoRefreshDemo(db);
    expect(calls).not.toContain("demo_auto_refresh_claim");
    expect(refreshed).not.toHaveBeenCalled();
  });

  it("a filled demo is claimed under the shared lock and refreshed once", async () => {
    refreshed.mockClear();
    const { db, calls } = fakeDb({ customers: 3 });
    await autoRefreshDemo(db);
    expect(calls).toEqual(["my_access", "demo_auto_refresh_claim", "demo_auto_refresh_finish"]);
    expect(refreshed).toHaveBeenCalledWith("prairie");
  });

  it("the first fill runs inside the lock: begin, the fill, then end", async () => {
    const { db, calls } = fakeDb({ customers: 0, begin: [true] });
    const order: string[] = [];
    await withDemoRefreshLock(db, async () => { order.push(`fill after ${calls.join(",")}`); });
    expect(order).toEqual(["fill after demo_refresh_begin"]);
    expect(calls).toEqual(["demo_refresh_begin", "demo_refresh_end"]);
  });
});
