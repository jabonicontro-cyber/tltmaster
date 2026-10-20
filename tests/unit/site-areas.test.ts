import { readdirSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AREAS, AREA_PATHS, SEGMENTS, SEGMENT_PATHS } from "@/lib/site/areas";
import { FEATURES } from "@/lib/site/features";
import { FOOTER_GROUPS, SITE_NAV } from "@/lib/site/nav";
import { SITE_PAGES, isPublicSiteRequest } from "@/lib/site/paths";
import { TIERS } from "@/lib/site/pricing";

// The public website's platform areas, solutions and navigation (docs/MARKETING.md): claims come only from published
// catalog features, every link is a public page that exists, and plans match the pricing source.

const published = new Set(FEATURES.filter((f) => f.published).map((f) => f.id));

describe("platform areas and solutions", () => {
  it("show only published features, and every area has a workflow, controls and connections", () => {
    for (const a of AREAS) {
      for (const id of a.features) expect(published.has(id), `${a.slug} uses unpublished feature ${id}`).toBe(true);
      expect(a.workflow.length).toBeGreaterThanOrEqual(3);
      expect(a.controls.length).toBeGreaterThan(0);
      for (const c of a.connects) expect(AREAS.some((x) => x.slug === c)).toBe(true);
    }
  });

  it("solutions map to real plans and areas", () => {
    for (const s of SEGMENTS) {
      expect(s.plans.length).toBeGreaterThan(0);
      for (const p of s.plans) expect(TIERS.some((t) => t.key === p)).toBe(true);
      for (const a of s.areas) expect(AREAS.some((x) => x.slug === a)).toBe(true);
      expect(s.scenario.steps.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("make no invented claims: no percentages, customer counts or testimonials", () => {
    const text = JSON.stringify({ AREAS, SEGMENTS });
    expect(text).not.toMatch(/\d+\s?%/);
    expect(text).not.toMatch(/\b(customers love|trusted by|testimonial|guarantee[ds]?)\b/i);
  });
});

describe("site navigation", () => {
  const hrefs = [...SITE_NAV.flatMap((g) => (g.links ? g.links.map((l) => l.href) : [g.href!])), ...FOOTER_GROUPS.flatMap((g) => g.links.map((l) => l.href))];

  it("links only to public pages (or sign-in) that exist", () => {
    for (const h of hrefs) {
      if (h === "/login") continue;
      expect(isPublicSiteRequest(h, "GET"), `${h} is not public`).toBe(true);
    }
    for (const p of [...AREA_PATHS, ...SEGMENT_PATHS, "/faq", "/trust"]) expect(SITE_PAGES as readonly string[]).toContain(p);
  });

  it("every public page has a page file", () => {
    for (const p of SITE_PAGES) {
      const dir = p === "/" ? "src/app/(site)" : `src/app/(site)${p}`;
      const dynamic = p.split("/").length === 3 ? `src/app/(site)/${p.split("/")[1]}` : null;
      const ok = existsSync(`${dir}/page.tsx`) || (dynamic !== null && readdirSync(dynamic).some((d) => d.startsWith("[") && existsSync(`${dynamic}/${d}/page.tsx`)));
      expect(ok, `${p} has no page`).toBe(true);
    }
  });
});
