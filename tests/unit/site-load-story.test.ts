import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURES, SCREENSHOTS } from "@/lib/site/features";
import { LOAD_STORY } from "@/lib/site/load-story";

// "One load, start to finish" on the home page (master plan UX16): every step describes a published, available catalog
// feature and shows that feature's own real screenshot, so the story can never show a screen or a claim the website may
// not make (docs/MARKETING.md).
describe("one load, start to finish", () => {
  it("follows the load from the quote to the invoice", () => {
    expect(LOAD_STORY.map((c) => c.step)).toEqual(["Quote", "Order", "Dispatch", "Deliver", "Review", "Bill"]);
    expect(new Set(LOAD_STORY.map((c) => c.title)).size).toBe(LOAD_STORY.length);
  });

  it("uses only published features and their own screenshots, which exist", () => {
    for (const c of LOAD_STORY) {
      const f = FEATURES.find((x) => x.id === c.feature);
      expect(f, c.feature).toBeTruthy();
      expect(f!.published && f!.status === "available", `${c.step}: ${c.feature} is not published`).toBe(true);
      expect(f!.screenshots, `${c.step}: ${c.shot} is not a screenshot of ${c.feature}`).toContain(c.shot);
      const shot = SCREENSHOTS.find((s) => s.id === c.shot)!;
      expect(existsSync(join(process.cwd(), "public/site", shot.file)), shot.file).toBe(true);
    }
  });

  it("makes no claim the catalog does not back", () => {
    const text = LOAD_STORY.flatMap((c) => [c.title, c.body, ...(c.points ?? [])]).join(" ").toLowerCase();
    for (const word of ["gps tracking", "ocr", "online payment", "drive time", "automatic assignment", "optimal", "guarantee"]) {
      expect(new RegExp(`\\b${word}\\b`).test(text), word).toBe(false);
    }
    // QuickBooks is mentioned only as coming soon.
    expect(text).toMatch(/quickbooks online sync is coming soon, not available yet/);
    expect(text).not.toContain("—");
  });
});
