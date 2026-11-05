import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/layout/nav";
import { OPTIONAL_AREAS, hiddenAreasOf, menuShows } from "@/lib/menu-areas";

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
