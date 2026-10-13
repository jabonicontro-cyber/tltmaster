# Development workflow and guarded deployment

How Taviron moves feature by feature from a requirement to Production. This is process, not a plan: what to build,
and in which order, lives in `docs/TAVIRON_MASTER_PLAN.md` (§11 roadmap, §12 feature backlog). Release checks are in
`docs/RELEASE_CHECKLIST.md`; deployment mechanics in `docs/DEPLOYMENT.md`.

## 1. Lifecycle of one feature

Each feature goes through these steps on its own. A feature that is blocked (waiting for approval, a decision or a
failing check) does not hold back unrelated features that are ready.

| Step | What happens | Where it is recorded |
| --- | --- | --- |
| 1. Requirements | Acceptance criteria written down: what a user can do, what must never happen, which roles and demo modes. Open questions go to master plan §9, never guessed. | Master plan §12 backlog row; §9 for open questions |
| 2. Dependencies and risk | Shared files, migrations, data and other features it depends on; its risk tier (§3). Features that share files or migrations are done one after the other, not in parallel. | Backlog row |
| 3. Implementation | On a non-production branch (§4). Small, independently testable commits. Demo parity is part of the feature (CLAUDE.md). | Commits; IMPLEMENTATION_PLAN section |
| 4. Automated checks | Lint, typecheck, unit, DB, browser tests, build, gate spec (§5). The feature's own acceptance tests, not only a build. | CI run; release report |
| 5. Review and approvals | The risk report (`scripts/release/risk.mjs`) lists approvals and extra checks. Approval-tier steps wait for the owner; everything else continues. | Release report |
| 6. Deployment | Push to the Preview branch (Preview deployment); after every check passes, fast-forward the Production branch (release rule, CLAUDE.md). | GitHub deployment records |
| 7. Post-deployment verification | Deployment record success for the exact commit; `scripts/check-deployment.mjs` against the deployed URL; a browser check when the session can reach it (this sandbox cannot reach `*.vercel.app`, so say "not verified live"). | Release report |
| 8. Release report | §6 template: implemented / tested / deployed / verified kept separate. | Chat report + SESSION_HANDOFF |
| 9. Next task | The highest backlog row that is ready (dependencies met, no open decision, no conflicting work in progress). | Backlog row status |

## 2. States

A feature's status is one of: **requested** → **specified** (acceptance criteria) → **implemented** (code written) →
**tested** (its checks ran and passed; say which) → **committed** → **pushed** (Preview) → **deployed** (deployment
record success for the commit) → **verified** (checked on the deployed site, or explicitly "not verified live").
A skipped or failed check is reported as skipped or failed, never as passed.

## 3. Risk tiers (guarded autonomy)

`node scripts/release/risk.mjs` classifies everything between the Production branch and the candidate; CI writes the
same report to each run's summary (job `release-risk`). The rules and their reasons are in the script
(`RULES`) and tested in `tests/unit/release-risk.test.ts`.

| Tier | Examples | What it allows |
| --- | --- | --- |
| **auto** | Docs, tests, public website, ordinary app UI and self-contained features, low-risk fixes | Promotion to Production after every required check passes (owner's standing release rule, 2026-10-11). |
| **review** | New migration files (code only), dependencies, CI, dispatch / billing / maintenance-safety / ticket workflows, sign-in and platform-adjacent code, demo data | Promotion after the extra checks the rule names: full browser suite, the feature's regression tests, permission and tenancy tests, and for migrations the **hosted-state check** (run the code against a database without the migration). |
| **approval** | Secrets and env files, hosting configuration (`vercel.json`, domains, cron, paid services), the authentication/authorization core (`src/server/auth.ts`, `src/proxy.ts`, `src/lib/permissions.ts`, `src/server/platform.ts`, site access), platform/role grants (`scripts/platform-admin.mjs`) | The owner approves that specific step. Work that does not depend on it continues. |

Always approval, whatever the classifier says (CLAUDE.md "Still explicit owner approval"): applying hosted
migrations or any hosted database change, environment variables or secrets, domains, account and role changes in
production, anything destructive or irreversible, force-pushes and history rewrites, new paid services. A green
test run never replaces these approvals. The owner may designate further high-impact workflows (dispatch, driver
safety, compliance, financial) as approval-tier by adding a rule.

When a feature needs an approval: isolate that step (e.g. ship code that works without the migration, document the
limitation), say exactly what is needed and why, and continue with other ready work.

## 4. Branches and environments

- `claude/top-line-trucking-manager-vmw04i` is Vercel's **Production Branch** (push only by fast-forward under the
  release rule; never force).
- `claude/ui-and-signin-checkpoint` (or any other branch) deploys to **Preview**. Feature work happens there or on a
  short-lived branch from it.
- Parallel sessions: one session per branch. Before editing, check `git log`/`git status` and the handoff for work
  in progress on the same files or migrations; if two features touch the same files or migration order, do them
  in sequence.
- Re-check which branch Production tracks (GitHub deployment records) before any push.

## 5. Quality gates

| Gate | Automated where | Notes |
| --- | --- | --- |
| Lint, typecheck, unit tests, production build | CI `checks` (every push) | |
| Database tests (RLS, tenancy, `SECURITY DEFINER` review, migrations from scratch) | CI `database` (every push) | Migrations are applied only to the throwaway CI database. |
| Critical browser workflows (sign-in, permissions, quotes, tenancy, roles, navigation, demo experience) on a production build | CI `e2e` (every push) | Full browser suite on demand: Actions → CI → Run workflow → *full_browser_suite*. Some specs use records earlier specs create (files run in name order: `quotes` before `tenancy`); keep that in mind when choosing a subset. |
| Early-access gate and public site; `check-deployment.mjs` against the local production build | CI `e2e` | |
| Release risk report | CI `release-risk` | Informational; approvals are given by the owner, not by CI. |
| Full browser suite, DB tests with the API stack (e.g. demo samples), hosted-state check, demo parity in every mode | Claude session, locally (SETUP §6) | Required by RELEASE_CHECKLIST before promotion. |
| Deployment record and post-deploy check | Claude session via GitHub (MCP) | Vercel records arrive 20–40 minutes after a push. |

CI cost: GitHub Actions minutes come from the repository owner's plan; the browser job takes roughly 15–25
minutes. No paid service was added; if minutes run short, the owner decides whether to limit the `e2e` job to the
release branches.

## 6. Release report template

```
Feature: <name> — <one-line summary>
Changed: <functional and visual changes>
Commits: <sha…> (Preview) · Production: <sha or "not promoted">
Risk tier: <auto|review|approval> (scripts/release/risk.mjs); approvals outstanding: <none | list>
Tests: <command → actual result, e.g. "vitest 540/540", "browser 110 passed / 0 failed / 10 skipped">; skipped: <list + why>
Demo modes: <affected modes; sample data; how existing demos receive it>
Deployment: Preview <state> · Production <state> (deployment record id/time)
Verified: <what was checked on the deployed site | "not verified live" + why>
Limitations: <known gaps, missing integrations>
Rollback: <Vercel instant rollback to <sha> | feature flag | migration rollback script> — <tested? verified?>
Next: <next eligible backlog row>
```

## 7. Recovery

- **App:** Vercel → Deployments → previous Production deployment → *Instant Rollback* (owner), or a revert commit
  fast-forwarded through the release rule. A rollback is reported as done only after the deployment record and
  `check-deployment.mjs` confirm it.
- **Feature disable:** features that depend on an unapplied migration already fall back to their "not available"
  state; there is no general feature-flag service (adding one is a later decision, no paid service).
- **Database:** migrations are additive; each reversible change has a tested script in `supabase/rollbacks/`
  (run by the owner with a backup, DEPLOYMENT §5).
- Promotion stops whenever a required check fails; the failure is reported with its output.

## 8. What runs without a person, and what does not

- **Automated by GitHub Actions on every push:** `checks`, `database`, `e2e` (critical), `release-risk`.
- **Automated by Vercel:** a deployment per push (Preview for non-production branches, Production for the
  Production branch).
- **Needs an active Claude session:** promotion (fast-forward of the Production branch), the full local gate run,
  hosted-state checks, release reports, backlog updates, demo Refresh on the local stack. Claude does not run in
  the background between sessions; scheduled check-ins only happen when the session environment provides them.
- **Needs the owner:** every approval-tier step (§3), hosted migrations, secrets, domains, Vercel instant rollback
  of Production, running **Refresh demo data** on hosted prospect demos.
