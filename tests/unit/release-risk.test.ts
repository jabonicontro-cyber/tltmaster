import { describe, expect, it } from "vitest";
import { RULES, classify, toMarkdown } from "../../scripts/release/risk.mjs";

// Guarded autonomy (docs/DEVELOPMENT_WORKFLOW.md §3): the release risk tiers decide which changes may be promoted
// automatically after the checks pass, which need extra checks, and which need the owner's approval.

type Result = { tier: string; items: Array<{ file: string; tier: string; rule: string }>; migrations: string[] };
const tierOf = (file: string) => (classify([file]) as Result).items[0].tier;
const ruleOf = (file: string) => (classify([file]) as Result).items[0].rule;

describe("release risk classification", () => {
  it("lets documentation, tests, public-site and ordinary UI changes through automatically", () => {
    for (const f of ["docs/BACKLOG.md", "README.md", "tests/e2e/x.spec.ts", "src/app/(site)/page.tsx", "public/site/a.png", "src/components/ui/avatar.tsx"]) {
      expect(tierOf(f), f).toBe("auto");
    }
  });

  it("needs the owner's approval for secrets, hosting configuration, the auth core and platform access", () => {
    for (const f of [".env.local", ".env.production", "vercel.json", "src/server/auth.ts", "src/proxy.ts", "src/lib/permissions.ts", "src/server/platform.ts", "src/server/site-access.ts", "scripts/platform-admin.mjs"]) {
      expect(tierOf(f), f).toBe("approval");
    }
    expect(tierOf(".env.example")).not.toBe("approval"); // a template, no secrets
  });

  it("flags migrations, dependencies, CI, high-impact workflows, access-adjacent code and demo data for review", () => {
    expect(ruleOf("supabase/migrations/20261109000100_demo_welcome.sql")).toBe("migration");
    expect(ruleOf("package.json")).toBe("dependencies");
    expect(ruleOf(".github/workflows/ci.yml")).toBe("ci");
    expect(ruleOf("src/lib/dispatch/smart.ts")).toBe("high-impact-workflow");
    expect(ruleOf("src/app/(app)/billing/page.tsx")).toBe("high-impact-workflow");
    expect(ruleOf("src/app/(app)/demo-actions.ts")).toBe("access-adjacent");
    expect(ruleOf("src/app/admin/actions.ts")).toBe("access-adjacent");
    expect(ruleOf("src/server/demo/samples.ts")).toBe("demo-seed");
    expect(ruleOf("something/unknown.bin")).toBe("other");
    for (const f of ["supabase/migrations/x.sql", "package.json", "src/lib/dispatch/smart.ts", "something/unknown.bin"]) expect(tierOf(f), f).toBe("review");
  });

  it("takes the highest tier of the range and lists hosted migrations", () => {
    const r = classify(["docs/a.md", "supabase/migrations/20261109000100_demo_welcome.sql", ""]) as Result;
    expect(r.tier).toBe("review");
    expect(r.migrations).toEqual(["supabase/migrations/20261109000100_demo_welcome.sql"]);
    expect((classify(["docs/a.md", "src/proxy.ts"]) as Result).tier).toBe("approval");
    expect((classify([]) as Result).tier).toBe("auto");
    const md = toMarkdown(r, "a...b") as string;
    expect(md).toContain("Release risk: REVIEW");
    expect(md).toContain("owner applies them; never automatic");
  });

  it("has a catch-all rule last, so every file is classified", () => {
    expect(RULES[RULES.length - 1].id).toBe("other");
  });
});
