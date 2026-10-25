#!/usr/bin/env node
// Release risk classification (docs/DEVELOPMENT_WORKFLOW.md §3). Classifies the files a release candidate changes
// against the Production branch into the guarded-autonomy tiers:
//   auto     — eligible for automatic promotion once every required check passes;
//   review   — eligible after the extra checks its rule names (recorded in the release report);
//   approval — needs the owner's explicit approval for that production step; the rest of the release may still
//              proceed only if it works without that step (e.g. code that runs safely before a migration is applied).
// It reads git only; it never deploys, applies migrations or touches secrets.
//
//   node scripts/release/risk.mjs [base] [head]        markdown report (base: origin/<production branch>, head: HEAD)
//   node scripts/release/risk.mjs --json [base] [head]
//   node scripts/release/risk.mjs --strict [base] [head]  exit 1 when anything needs approval (for gating)

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PRODUCTION_BRANCH = "main"; // DEPLOYMENT §2b (was claude/top-line-trucking-manager-vmw04i until 2026-10-25)

/** Ordered rules: the first match decides a file's tier. Keep in sync with docs/DEVELOPMENT_WORKFLOW.md §3. */
export const RULES = [
  { tier: "approval", id: "secrets", test: (f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".env.example"), why: "Environment or secret file: secrets are set by the owner, never committed." },
  { tier: "approval", id: "infrastructure", test: (f) => f === "vercel.json" || /^supabase\/config\.toml$/.test(f), why: "Hosting, cron or platform configuration: owner approval (cost, domains, schedules)." },
  { tier: "approval", id: "auth-core", test: (f) => ["src/server/auth.ts", "src/proxy.ts", "src/lib/permissions.ts", "src/server/platform.ts"].includes(f) || /^src\/(server|lib)\/site-access/.test(f), why: "Authentication or authorization core: material security change needs explicit approval." },
  { tier: "approval", id: "platform-access", test: (f) => f === "scripts/platform-admin.mjs", why: "Grants platform or demo-owner access: production role changes need approval." },
  { tier: "review", id: "migration", test: (f) => /^supabase\/migrations\/.+\.sql$/.test(f), why: "New migration: applying it to the hosted database is an owner action (always approval). The code ships only if verified against a database without it (hosted-state check)." },
  { tier: "review", id: "rollback", test: (f) => /^supabase\/rollbacks\//.test(f), why: "Rollback script: tested apply → rollback → re-apply locally." },
  { tier: "review", id: "dependencies", test: (f) => f === "package.json" || f === "package-lock.json", why: "Dependencies changed: check licence, size, audit; a paid service needs approval." },
  { tier: "review", id: "ci", test: (f) => /^\.github\//.test(f), why: "CI workflow changed: the change itself must pass the CI it defines." },
  { tier: "review", id: "high-impact-workflow", test: (f) => /^src\/(lib|server|app\/\(app\))\/(dispatch|billing|maintenance|time-off|tickets)\b/.test(f) || /^src\/server\/data\/(dispatch|billing|maintenance)/.test(f) || f === "src/lib/dispatch/smart.ts", why: "Dispatch, billing, maintenance safety or ticket workflow: full browser suite and the feature's regression tests are required." },
  { tier: "review", id: "access-adjacent", test: (f) => /^src\/(lib\/platform|app\/admin|app\/\(auth\)|app\/auth|app\/account)\//.test(f) || /^src\/app\/\(app\)\/(demo-actions|settings\/actions)\.ts$/.test(f), why: "Sign-in, platform, account or role-preview code: permission and tenancy tests required." },
  { tier: "review", id: "ai", test: (f) => /^src\/(server|lib)\/ai\//.test(f) || f === "src/components/dispatch/plan-explanation.tsx" || f === ".env.example" || f === "vitest.config.mts", why: "AI runtime or its configuration (docs/AI.md): mocked AI tests and the AI release checklist (§4a) required; keys, enabling a capability and the paid provider stay owner approval." },
  { tier: "review", id: "demo-seed", test: (f) => /^src\/server\/demo\//.test(f), why: "Demo data: demo-parity and demo-samples tests required; Refresh stays idempotent." },
  { tier: "auto", id: "docs", test: (f) => /\.(md|txt)$/.test(f) || /^docs\//.test(f), why: "Documentation only." },
  { tier: "auto", id: "tests", test: (f) => /^tests\//.test(f) || /\.(test|spec)\.tsx?$/.test(f), why: "Tests only." },
  { tier: "auto", id: "public-site", test: (f) => /^src\/(app\/\(site\)|components\/site|lib\/site)\//.test(f) || /^public\//.test(f), why: "Public website (claims checked against src/lib/site/capabilities.ts)." },
  { tier: "auto", id: "app-ui", test: (f) => /^src\/(components|app)\//.test(f) || /^src\/lib\//.test(f), why: "Application code with no designated high-risk area." },
  { tier: "review", id: "other", test: () => true, why: "Not covered by a rule: classify by hand." },
];

const ORDER = { auto: 0, review: 1, approval: 2 };

/** Classify changed paths. Returns the overall tier and each file's rule. */
export function classify(files) {
  const items = files.filter(Boolean).map((file) => {
    const rule = RULES.find((r) => r.test(file));
    return { file, tier: rule.tier, rule: rule.id, why: rule.why };
  });
  const tier = items.reduce((t, i) => (ORDER[i.tier] > ORDER[t] ? i.tier : t), "auto");
  const migrations = items.filter((i) => i.rule === "migration").map((i) => i.file);
  return { tier, items, migrations };
}

export function toMarkdown({ tier, items, migrations }, range) {
  const lines = [`## Release risk: ${tier.toUpperCase()}`, "", `Range: \`${range}\` — ${items.length} changed file(s).`, ""];
  if (migrations.length) {
    lines.push("**Hosted migrations in this range (owner applies them; never automatic):**", ...migrations.map((m) => `- \`${m}\``), "");
  }
  for (const t of ["approval", "review", "auto"]) {
    const group = items.filter((i) => i.tier === t);
    if (!group.length) continue;
    lines.push(`### ${t} (${group.length})`);
    const byRule = new Map();
    for (const i of group) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
    for (const [rule, list] of byRule) {
      lines.push(`- **${rule}** — ${list[0].why}`);
      for (const i of list.slice(0, 15)) lines.push(`  - \`${i.file}\``);
      if (list.length > 15) lines.push(`  - … and ${list.length - 15} more`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(argv) {
  const json = argv.includes("--json");
  const strict = argv.includes("--strict");
  const [base = `origin/${PRODUCTION_BRANCH}`, head = "HEAD"] = argv.filter((a) => !a.startsWith("--"));
  const range = `${base}...${head}`;
  const files = execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" }).split("\n");
  const result = classify(files);
  process.stdout.write(json ? `${JSON.stringify({ range, ...result }, null, 2)}\n` : `${toMarkdown(result, range)}\n`);
  if (strict && result.tier === "approval") process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
