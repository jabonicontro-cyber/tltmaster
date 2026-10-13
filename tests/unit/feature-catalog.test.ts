import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "@/components/layout/nav";
import { FEATURES, NOT_MARKETED, NOT_YET, SCREENSHOTS, publishedFeatures } from "@/lib/site/features";

// The feature catalog drives the public website (docs/MARKETING.md). These checks stop the site from drifting away
// from the product: unbuilt work cannot be published, published claims point at real pages and real screenshots,
// every page in the app is either covered by a feature or deliberately left out, and screenshots are not orphaned.

const ROOT = process.cwd();
const APP = join(ROOT, "src/app/(app)");
const SITE = join(ROOT, "src/app/(site)");
const PUBLIC_SITE = join(ROOT, "public/site");

describe("feature catalog", () => {
  it("ids and names are unique; related features exist", () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = FEATURES.map((f) => f.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const f of FEATURES) for (const r of f.related) expect(ids, `${f.id} → ${r}`).toContain(r);
  });

  it("only available features may be published; planned and unreleased work never is", () => {
    for (const f of FEATURES) if (f.published) expect(f.status, f.id).toBe("available");
    for (const f of FEATURES.filter((x) => x.status === "planned" || x.status === "in_development")) expect(f.published, f.id).toBe(false);
  });

  it("published features are complete: copy, app pages that exist, screenshots that exist, recently verified", () => {
    const now = Date.now();
    for (const f of publishedFeatures()) {
      for (const field of ["problem", "how", "value"] as const) expect(f[field].length, `${f.id}.${field}`).toBeGreaterThan(20);
      expect(f.points.length, f.id).toBeGreaterThan(0);
      expect(f.routes.length, f.id).toBeGreaterThan(0);
      for (const route of f.routes) expect(existsSync(join(APP, route, "page.tsx")), `${f.id}: ${route}`).toBe(true);
      for (const id of f.screenshots) {
        const shot = SCREENSHOTS.find((s) => s.id === id);
        expect(shot, `${f.id}: screenshot ${id}`).toBeTruthy();
        expect(shot!.feature, id).toBe(f.id);
        expect(existsSync(join(PUBLIC_SITE, shot!.file)), `${f.id}: public/site/${shot!.file} (run scripts/capture-screenshots.mjs)`).toBe(true);
      }
      const age = (now - new Date(f.verified).getTime()) / 86_400_000;
      expect(age, `${f.id} was last verified ${f.verified}; re-check it against the app`).toBeLessThan(120);
    }
  });

  it("every page in the app's navigation is covered by a feature or deliberately not marketed", () => {
    const covered = new Set(FEATURES.flatMap((f) => f.routes));
    const missing = NAV_ITEMS.map((n) => n.href).filter((href) => !covered.has(href) && !(href in NOT_MARKETED));
    expect(missing, "New app pages need a feature entry in src/lib/site/features.ts (or a reason in NOT_MARKETED)").toEqual([]);
  });

  it("screenshots: every entry belongs to a feature and has alt text; no orphaned image files", () => {
    const featureIds = new Set(FEATURES.map((f) => f.id));
    for (const s of SCREENSHOTS) {
      expect(featureIds.has(s.feature), `screenshot ${s.id} belongs to unknown feature ${s.feature}`).toBe(true);
      expect(s.alt.length, s.id).toBeGreaterThan(30);
      expect(s.caption, s.id).toMatch(/demo company|fictional/i);
    }
    const files = new Set(SCREENSHOTS.map((s) => s.file));
    const onDisk = readdirSync(PUBLIC_SITE).filter((f) => f.endsWith(".png"));
    // Any image in public/site must be a catalogued screenshot, or referenced directly by a site page.
    const pages = readdirSync(SITE, { recursive: true }).filter((f) => String(f).endsWith(".tsx")).map((f) => readFileSync(join(SITE, String(f)), "utf8")).join("\n")
      + readFileSync(join(ROOT, "src/components/site/product-showcase.tsx"), "utf8");
    for (const f of onDisk) expect(files.has(f) || pages.includes(`/site/${f}`), `public/site/${f} is not used`).toBe(true);
  });

  it("public copy does not claim what is not built", () => {
    const text = publishedFeatures().flatMap((f) => [f.how, f.value, ...f.points]).join(" ").toLowerCase();
    for (const word of ["quickbooks", "gps tracking", "ocr", "payroll integration", "online payment", "drive time", "automatic assignment", "edi", "optimal", "guarantee"]) {
      expect(new RegExp(`\\b${word}\\b`).test(text), word).toBe(false);
    }
    expect(NOT_YET.join(" ")).toMatch(/QuickBooks/);
  });
});
