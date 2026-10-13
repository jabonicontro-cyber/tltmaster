import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AVAILABLE } from "@/lib/site/capabilities";
import { RELEASES, publicHighlights, type ReleaseHighlight } from "@/lib/site/releases";

// Release highlights reach the public website only when published with an approval, and only for features the app
// can show (docs/DEVELOPMENT_WORKFLOW.md; CLAUDE.md "Public website claims").
const APP = join(process.cwd(), "src/app/(app)");
const PUBLIC = join(process.cwd(), "public");

describe("release highlights", () => {
  it("every highlight names app pages that exist and an image that exists", () => {
    for (const r of RELEASES) {
      expect(r.evidence.length, r.id).toBeGreaterThan(0);
      for (const route of r.evidence) expect(existsSync(join(APP, route, "page.tsx")), `${r.id}: ${route}`).toBe(true);
      if (r.image) expect(existsSync(join(PUBLIC, r.image.src)), r.image.src).toBe(true);
      expect(r.limitations.length, `${r.id} says what it does not do`).toBeGreaterThan(0);
    }
  });

  it("approved and published highlights carry an approval; published ones are also listed as available", () => {
    const available = AVAILABLE.flatMap((c) => c.evidence);
    for (const r of RELEASES) {
      if (r.status !== "draft") expect(r.approval, r.id).not.toBeNull();
      if (r.status === "published") for (const route of r.evidence) expect(available, `${r.id}: add ${route} to capabilities.ts first`).toContain(route);
    }
  });

  it("only published and approved highlights are public, newest first", () => {
    const base: ReleaseHighlight = { id: "x", title: "x", summary: "", benefits: [], limitations: ["l"], releasedOn: "2026-01-01", evidence: ["/dispatch"], image: null, status: "draft", approval: null };
    const list: ReleaseHighlight[] = [
      { ...base, id: "draft" },
      { ...base, id: "approved", status: "approved", approval: { by: "Owner", on: "2026-01-02" } },
      { ...base, id: "old", status: "published", approval: { by: "Owner", on: "2026-01-02" }, releasedOn: "2026-01-01" },
      { ...base, id: "new", status: "published", approval: { by: "Owner", on: "2026-02-02" }, releasedOn: "2026-02-01" },
      { ...base, id: "unapproved", status: "published", approval: null },
    ];
    expect(publicHighlights(list).map((r) => r.id)).toEqual(["new", "old"]);
    expect(publicHighlights().every((r) => r.status === "published")).toBe(true);
  });
});
