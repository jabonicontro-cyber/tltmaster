import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AVAILABLE, PLANNED } from "@/lib/site/capabilities";
import { COMING_SOON } from "@/lib/site/features";

// The public website may only describe what the app can show. Every available
// capability names app pages that exist; planned items stay in the "Not yet" list.
const APP = join(process.cwd(), "src/app/(app)");

describe("public website capabilities", () => {
  it("every available capability points at app pages that exist", () => {
    for (const c of AVAILABLE) {
      expect(c.evidence.length, c.title).toBeGreaterThan(0);
      for (const route of c.evidence) expect(existsSync(join(APP, route, "page.tsx")), `${c.title}: ${route}`).toBe(true);
    }
  });

  it("planned work is not described as available", () => {
    const available = AVAILABLE.flatMap((c) => c.points).join(" ").toLowerCase();
    for (const word of ["quickbooks", "gps", "ocr", "payroll integration", "online payment", "drive time", "automatic assignment"]) {
      expect(available).not.toContain(word);
    }
    // QuickBooks is announced as coming soon (owner 2026-10-25), never as available.
    expect(COMING_SOON.map((c) => c.name).join(" ")).toMatch(/QuickBooks/);
    expect(PLANNED.join(" ")).toMatch(/Travel distance/);
  });
});
