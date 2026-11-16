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

describe("screens follow the modules", () => {
  it("Command Center leaves out the items, counts and cards of switched-off areas, never safety", async () => {
    const { summaryForModules, itemsForModules, kindShown } = await import("@/lib/command-center/modules");
    const { metricCards } = await import("@/lib/command-center/rules");
    const s = {
      as_of: "", today: "2026-11-16", exceptions: { total: 9, urgent: 3, mine: 0 },
      urgent_by_kind: { unassigned_load: 2, equipment_report: 1 }, by_kind: { unassigned_load: 4, ticket_review: 3, equipment_report: 2 },
      orders_today: 1, orders_unscheduled: 2, urgent_orders: 0, loads_today: 5, loads_today_assigned: 1, unassigned_loads: 4, assignment_problems: 0,
      trucks_out_of_service: 1, trailers_out_of_service: 0, tickets_to_review: 3, missing_tickets: 0, billing_blocked: 0, billing_ready: 1, driver_reports: 2,
      can: { dispatch: true, fleet: true, billing: true, tickets: true, assign: true },
    };
    const f = summaryForModules(s, ["dispatch"]);
    expect(f.exceptions).toMatchObject({ total: 5, urgent: 1 });
    expect(f.by_kind.unassigned_load).toBeUndefined();
    // Applying it twice changes nothing (the summary is shared by several pages).
    expect(summaryForModules(f, ["dispatch"]).exceptions).toEqual(f.exceptions);
    const keys = metricCards(f).map((c) => c.key);
    expect(keys).not.toContain("loads_today");
    expect(keys).toContain("out_of_service");
    expect(keys).toContain("driver_reports");
    expect(kindShown("equipment_report", [...MODULE_KEYS])).toBe(true);
    const page = itemsForModules({ total: 3, items: [{ kind: "unassigned_load" }, { kind: "ticket_review" }, { kind: "delay_report" }] as never }, ["dispatch", "tickets"]);
    expect((page.items as Array<{ kind: string }>).map((i) => i.kind)).toEqual(["delay_report"]);
    expect(page.total).toBe(1);
  });

  it("order steps adapt: no dispatch step and ticket entry per job when Dispatch is off", async () => {
    const { orderProgress } = await import("@/lib/orders/progress");
    const steps = orderProgress({ orderId: "o", orderStatus: "in_progress", loads: [], billing: null, now: new Date(), modulesOff: ["dispatch"] });
    expect(steps.map((s) => s.key)).toEqual(["tickets", "billing"]);
    expect(steps[0].next?.href).toBe("/tickets/new");
    expect(orderProgress({ orderId: "o", orderStatus: "in_progress", loads: [], billing: null, now: new Date() }).map((s) => s.key)).toEqual(["dispatch", "tickets", "billing"]);
  });

  it("help leaves out articles only about switched-off areas", async () => {
    const { helpFor } = await import("@/server/help");
    const { PERMISSIONS } = await import("@/lib/permissions");
    const all = helpFor([...PERMISSIONS]);
    const some = helpFor([...PERMISSIONS], ["dispatch"]);
    expect(some.articles.length).toBeLessThan(all.articles.length);
    for (const a of some.articles) expect(a.routes.length === 0 || a.routes.some((r) => hrefShown(r.replace(/\/\*$/, "") || "/", ["dispatch"]))).toBe(true);
  });
});
