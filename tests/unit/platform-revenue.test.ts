// Revenue over time (PC2): the page's small formatting rules, and that the page is in the Admin navigation only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSOLE_GROUPS, SUPPORT_LINKS, groupOf } from "@/components/admin/ui/nav";
import { barHeights, changeText, customersSubText, monthLabel, namesText, revenueRange } from "@/lib/platform/revenue";

describe("revenue over time formatting", () => {
  it("reads months, changes and names as people read them", () => {
    expect(monthLabel("2026-11")).toBe("Nov 2026");
    expect(monthLabel("2027-01")).toBe("Jan 2027");
    expect(changeText(25000)).toBe("+$250");
    expect(changeText(-99900)).toBe("−$999");
    expect(changeText(0)).toBe("No change");
    expect(changeText(null)).toBe("–");
    const c = (name: string) => ({ id: name, name, cents: 1 });
    expect(namesText([])).toBe("");
    expect(namesText([c("A"), c("B")])).toBe("A, B");
    expect(namesText([c("A"), c("B"), c("C"), c("D"), c("E")])).toBe("A, B, C and 2 more");
    expect(customersSubText({ paying: 3, free: 1, not_recorded: 0 })).toBe("3 paying · 1 free");
    expect(customersSubText({ paying: 0, free: 0, not_recorded: 2 })).toBe("2 amount not recorded");
  });
  it("accepts only the offered ranges and never divides by zero for the chart", () => {
    expect(revenueRange("6")).toBe(6);
    expect(revenueRange("24")).toBe(24);
    expect(revenueRange("36")).toBe(12);
    expect(revenueRange(undefined)).toBe(12);
    expect(revenueRange(["24", "6"])).toBe(24);
    expect(barHeights([{ agreed_cents: 0 }, { agreed_cents: 0 }])).toEqual([0, 0]);
    expect(barHeights([{ agreed_cents: 50 }, { agreed_cents: 100 }, { agreed_cents: 0 }])).toEqual([50, 100, 0]);
  });
  it("is labelled agreed, not collected, and is in the Admin console only", () => {
    const page = readFileSync(join(__dirname, "../../src/app/admin/revenue/page.tsx"), "utf8");
    expect(page).toMatch(/Agreed, not collected/);
    expect(page).toMatch(/requirePlatformAdmin\(\)/);
    expect(groupOf("/admin/revenue")).toBe("Customers");
    expect(CONSOLE_GROUPS.flatMap((g) => g.links).some((l) => l.href === "/admin/revenue")).toBe(true);
    expect(SUPPORT_LINKS.some((l) => l.href.includes("revenue"))).toBe(false);
  });
});
