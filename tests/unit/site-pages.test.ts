import { describe, expect, it } from "vitest";
import { FEATURES } from "@/lib/site/features";
import { COMPARISONS, COMPARE_PATHS } from "@/lib/site/compare";
import { paperworkCost } from "@/lib/site/calculator";
import { PUBLIC_GUIDES, publicGuides } from "@/lib/site/guides";
import { HELP_ARTICLES } from "@/lib/help/articles";
import { SITE_PAGES } from "@/lib/site/paths";

// Resource pages of the public website (master plan B88): comparisons, the paperwork calculator and the public guides.
// Claims rest on published catalog features only; nothing names a competitor or invents a figure.

const published = new Set(FEATURES.filter((f) => f.published).map((f) => f.id));

describe("comparison pages", () => {
  it("every Taviron statement rests on a published feature, and each page says what Taviron does not do yet", () => {
    for (const c of COMPARISONS) {
      for (const r of c.rows) expect(published.has(r.feature), `${c.slug}: ${r.topic} uses ${r.feature}`).toBe(true);
      expect(c.notYet.length).toBeGreaterThan(0);
      expect(c.fairPoints.length).toBeGreaterThan(0);
    }
    for (const p of COMPARE_PATHS) expect(SITE_PAGES as readonly string[]).toContain(p);
  });

  it("make no invented claims: no figures, competitor names or testimonials", () => {
    const text = JSON.stringify(COMPARISONS);
    expect(text).not.toMatch(/\d+\s?%|\d+x faster|\$\d/i);
    expect(text).not.toMatch(/\b(tread|truckit|trux|toro|dump truck dispatcher|hcss|command alkon|haulhub)\b/i);
    expect(text).not.toMatch(/\b(customers love|trusted by|testimonial|guarantee[ds]?)\b/i);
  });
});

describe("paperwork calculator", () => {
  it("shows nothing until the visitor's own numbers are complete and valid", () => {
    expect(paperworkCost({})).toBeNull();
    expect(paperworkCost({ trucks: "10", loadsPerTruck: "6", daysPerWeek: "5" })).toBeNull();
    expect(paperworkCost({ trucks: "-1", loadsPerTruck: "6", daysPerWeek: "5", minutesPerTicket: "4" })).toBeNull();
    expect(paperworkCost({ trucks: "10", loadsPerTruck: "abc", daysPerWeek: "5", minutesPerTicket: "4" })).toBeNull();
    expect(paperworkCost({ trucks: "10", loadsPerTruck: "6", daysPerWeek: "8", minutesPerTicket: "4" })).toBeNull();
  });

  it("works out tickets, hours and, with an hourly cost, the cost a year", () => {
    expect(paperworkCost({ trucks: "10", loadsPerTruck: "6", daysPerWeek: "5", minutesPerTicket: "4" })).toEqual({ ticketsPerWeek: 300, hoursPerWeek: 20, costPerYear: null });
    expect(paperworkCost({ trucks: 10, loadsPerTruck: 6, daysPerWeek: 5, minutesPerTicket: 4, hourlyCost: 30 })).toEqual({ ticketsPerWeek: 300, hoursPerWeek: 20, costPerYear: 31_200 });
  });
});

describe("public guides", () => {
  it("are Help Center articles for published features, none about settings or administration", () => {
    expect(publicGuides()).toHaveLength(PUBLIC_GUIDES.length);
    for (const g of PUBLIC_GUIDES) {
      expect(published.has(g.feature), `${g.article} → ${g.feature}`).toBe(true);
      const a = HELP_ARTICLES.find((x) => x.id === g.article)!;
      expect(a.category).not.toBe("settings");
      expect(a.tasks.length).toBeGreaterThan(0);
    }
  });
});
