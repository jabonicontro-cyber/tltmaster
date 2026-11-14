import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/layout/nav";
import { OPTIONAL_AREAS, STARTER_HIDDEN_AREAS, hiddenAreasOf, menuShows } from "@/lib/menu-areas";

// Simple mode (SF1): only optional areas can be hidden; safety and the daily core always show.
describe("menu areas", () => {
  it("keeps only known optional areas", () => {
    expect(hiddenAreasOf(["/quotes", "/quotes", "/safety", "/dispatch", 7, "/payroll"])).toEqual(["/quotes", "/payroll"]);
    expect(hiddenAreasOf("nope")).toEqual([]);
  });

  it("never hides safety or the daily core, whatever is stored", () => {
    const all = OPTIONAL_AREAS.map((a) => a.href) as string[];
    for (const href of ["/safety", "/field-reports", "/communications", "/dispatch", "/orders", "/tickets", "/fleet", "/billing", "/settings", "/driver"]) {
      expect(menuShows(href, [...all, href]), href).toBe(true);
    }
    expect(menuShows("/quotes", ["/quotes"])).toBe(false);
  });

  it("names only areas that are in the menu", () => {
    const hrefs = new Set(NAV_ITEMS.map((i) => i.href));
    for (const a of OPTIONAL_AREAS) expect(hrefs.has(a.href), a.href).toBe(true);
  });
});

// New Starter companies (owner decision 2026-11-14, migration 20261120022200): every optional area hidden except
// Maintenance, and the database uses exactly the same list.
describe("Starter plan menu defaults", () => {
  it("hides every optional area except Maintenance, the same list as the database", () => {
    expect(STARTER_HIDDEN_AREAS).not.toContain("/maintenance");
    expect([...STARTER_HIDDEN_AREAS, "/maintenance"].sort()).toEqual(OPTIONAL_AREAS.map((a) => a.href).sort());
    const sql = readFileSync(new URL("../../supabase/migrations/20261120022200_starter_default_hidden_areas.sql", import.meta.url), "utf8");
    const list = sql.match(/v_areas constant text\[\] := array\[([^\]]+)\]/)?.[1].split(",").map((x) => x.trim().replace(/'/g, ""));
    expect(list).toEqual([...STARTER_HIDDEN_AREAS]);
  });
});
