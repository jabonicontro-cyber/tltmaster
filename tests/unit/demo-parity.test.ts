import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Demo tenants run the same application as every company (docs/DEMO_TENANTS.md). The only places allowed to
// branch on a company being a demo are the intentional differences documented in DEMO_TENANTS.md §2. A new
// branch fails this test until it is documented there with its reason — so demos never quietly drift into a
// separate version of the product.

const ROOT = join(__dirname, "..", "..");
const ALLOWED = new Set([
  "src/server/auth.ts",
  "src/components/layout/app-shell.tsx",
  "src/app/(app)/layout.tsx",
  "src/app/(app)/demo-actions.ts",
  "src/server/data/profile.ts",
  "src/app/(app)/driver/page.tsx",
  "src/app/(app)/quotes/actions.ts",
  "src/server/people/invite.ts",
  "src/app/admin/actions.ts",
  "src/app/admin/demo/page.tsx",
  "src/lib/ai/capabilities.ts",
  "src/server/ai/gates.ts",
  "src/server/routing/service.ts",
  "src/lib/permissions.ts", // the Access type's isDemo field
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("demo parity", () => {
  it("only the documented places branch on demo companies", () => {
    const branching = files(join(ROOT, "src"))
      .map((f) => relative(ROOT, f))
      .filter((f) => !f.startsWith("src/server/demo/")) // the demo seed and refresh themselves
      .filter((f) => /\bisDemo\b|\bis_demo\b|\bdemo_kind\b/.test(readFileSync(join(ROOT, f), "utf8")));
    const undocumented = branching.filter((f) => !ALLOWED.has(f));
    expect(undocumented, "Document these in docs/DEMO_TENANTS.md §2 and add them to ALLOWED").toEqual([]);
  });

  it("every allowed place is listed in DEMO_TENANTS.md", () => {
    const doc = readFileSync(join(ROOT, "docs", "DEMO_TENANTS.md"), "utf8");
    for (const f of ALLOWED) if (f !== "src/lib/permissions.ts") expect(doc, f).toContain(f);
  });
});
