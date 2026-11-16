import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/layout/nav";
import { MODULES, MODULE_KEYS, PRESETS, STARTER_OFF, dependencyProblem, hrefShown, moduleOfHref, modulesOff, presetOf, toggleModule } from "@/lib/modules";

// Workflow modules (MOD1, docs/MODULES.md): only known modules can be off; safety and the always-on areas never hide;
// dependencies are kept; presets and the Starter default match the database.
const SQL = readFileSync(new URL("../../supabase/migrations/20261120023000_workflow_modules.sql", import.meta.url), "utf8");

describe("workflow modules", () => {
  it("keeps only known modules, once each", () => {
    expect(modulesOff(["dispatch", "dispatch", "safety", 7, "quotes", "/quotes"])).toEqual(["quotes", "dispatch"]);
    expect(modulesOff("nope")).toEqual([]);
  });

  it("never hides safety, communications or the always-on areas, whatever is stored", () => {
    for (const href of ["/safety", "/field-reports", "/communications", "/fleet", "/customers", "/employees", "/settings", "/driver", "/command-center", "/briefing", "/materials", "/search", "/help"]) {
      expect(hrefShown(href, [...MODULE_KEYS]), href).toBe(true);
    }
  });

  it("maps every page of a module, with query strings and sub-pages", () => {
    expect(moduleOfHref("/tickets?view=check")).toBe("tickets");
    expect(moduleOfHref("/dispatch/plan")).toBe("dispatch");
    expect(moduleOfHref("/billing/invoices/123#top")).toBe("billing");
    expect(moduleOfHref("/orders-archive")).toBe(null);
    expect(hrefShown("/quotes/new", ["quotes"])).toBe(false);
    expect(hrefShown("/quotes/new", ["dispatch"])).toBe(true);
  });

  it("every module's main page is in the menu", () => {
    const hrefs = new Set(NAV_ITEMS.map((i) => i.href));
    for (const m of MODULES) expect(hrefs.has(m.hrefs[0]), m.key).toBe(true);
  });

  it("keeps dependencies when switching", () => {
    expect(toggleModule([], "orders", false).off).toEqual(["orders", "dispatch", "tickets", "billing", "order_to_cash", "payroll"]);
    expect(toggleModule([], "tickets", false).alsoChanged.sort()).toEqual(["billing", "order_to_cash", "payroll"]);
    const back = toggleModule(["orders", "dispatch", "tickets", "billing", "order_to_cash", "payroll"], "payroll", true);
    expect(back.off).toEqual(["dispatch", "billing", "order_to_cash"]);
    expect(back.alsoChanged.sort()).toEqual(["orders", "tickets"]);
    expect(dependencyProblem(["orders"])).toMatch(/Dispatch needs Orders and jobs/);
    for (const p of Object.values(PRESETS)) expect(dependencyProblem(p.off), p.label).toBe(null);
  });

  it("recognises the presets and matches the database lists", () => {
    expect(presetOf([])).toBe("full");
    expect(presetOf([...PRESETS.quotes_only.off].reverse())).toBe("quotes_only");
    expect(presetOf(["quotes"])).toBe(null);
    for (const [key, p] of Object.entries(PRESETS)) {
      if (key === "full") continue;
      const list = SQL.match(new RegExp(`when '${key}' then array\\[([^\\]]+)\\]`))?.[1].split(",").map((x) => x.trim().replace(/'/g, ""));
      expect(list, key).toEqual([...p.off]);
    }
    expect(SQL.match(/array\['quotes', 'orders'[^\]]+\]/)?.[0].match(/'([a-z_]+)'/g)?.map((x) => x.replace(/'/g, ""))).toEqual([...MODULE_KEYS]);
  });

  it("Starter companies start with the essentials (owner 2026-11-14): the same list as the database", () => {
    expect(STARTER_OFF).not.toContain("maintenance");
    const list = SQL.match(/v_modules constant text\[\] := array\[([^\]]+)\]/)?.[1].split(",").map((x) => x.trim().replace(/'/g, ""));
    expect(list).toEqual([...STARTER_OFF]);
    expect(dependencyProblem(STARTER_OFF)).toBe(null);
  });
});
