import { describe, expect, it } from "vitest";
import { cleanQuery, ilikePattern, searchableGroups } from "@/lib/search";

describe("global search", () => {
  it("searches only the groups the person's permissions open", () => {
    expect(searchableGroups(["driver.portal"])).toEqual([]);
    expect(searchableGroups(["orders.view", "tickets.view"]).map((g) => g.key)).toEqual(["orders", "tickets"]);
    expect(searchableGroups(["fleet.view"]).map((g) => g.key)).toEqual(["trucks", "trailers", "drivers"]);
  });

  it("input can never change the filter: wildcards are literal and PostgREST syntax characters are dropped", () => {
    expect(ilikePattern("O-2026")).toBe("%O-2026%");
    expect(ilikePattern("50%_off")).toBe("%50\\%\\_off%");
    expect(ilikePattern("a),company_id.eq.(x")).not.toMatch(/[(),]/);
    expect(ilikePattern(`x"y'z\\`)).not.toMatch(/["'\\](?!%|_)/);
  });

  it("needs 2 to 80 characters", () => {
    expect(cleanQuery("a")).toBeNull();
    expect(cleanQuery("  ab  ")).toBe("ab");
    expect(cleanQuery("x".repeat(200))).toHaveLength(80);
  });
});

describe("referenceKey", () => {
  it("accepts a reference typed any way and ignores plain words", async () => {
    const { referenceKey } = await import("@/lib/search");
    expect(referenceKey("ORD-1042")).toBe("ORD1042");
    expect(referenceKey("ord 1042")).toBe("ORD1042");
    expect(referenceKey("o-2026-0001")).toBe("O20260001");
    expect(referenceKey("1042")).toBe("1042");
    expect(referenceKey("Riverbend")).toBeNull();
    expect(referenceKey("")).toBeNull();
    expect(referenceKey("ORD-1042'),id.eq.(x")).toBe("ORD1042IDEQX");
  });
});
